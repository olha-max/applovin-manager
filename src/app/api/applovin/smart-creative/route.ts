import { NextRequest } from "next/server";
import { smartCreativeSchema } from "@/lib/validators";
import { getAuthUser, jsonError, getClientIp } from "@/lib/api-utils";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { parseDriveFolderUrl, findFileRecursive, downloadDriveFile } from "@/lib/google-drive";
import {
  uploadAsset,
  findAssetByName,
  listAssets,
  listCampaigns,
  listCreativeSets,
  createCreativeSet,
} from "@/lib/applovin";
import {
  getAssetReport,
  extractAngle,
  detectAssetType,
  findTopComplementaryAssets,
} from "@/lib/applovin-reporting";
import { resizeStaticToAppLovinSpec } from "@/lib/image-resize";

export const maxDuration = 60;

interface Campaign {
  id: string;
  name: string;
  type?: string;
  [key: string]: unknown;
}

interface CreativeSet {
  id: string;
  name: string;
  campaign_id?: string;
  [key: string]: unknown;
}

// In-memory кеш щоб не робити однакові запити для кожного креативу в batch
const cache: {
  campaigns?: { data: Campaign[]; ts: number };
  creativeSets?: { data: CreativeSet[]; ts: number };
  report?: { data: import("@/lib/applovin-reporting").AssetReportEntry[]; ts: number };
} = {};
const CACHE_TTL = 60_000; // 1 хвилина

async function getCachedCampaigns(): Promise<Campaign[]> {
  if (cache.campaigns && Date.now() - cache.campaigns.ts < CACHE_TTL) {
    return cache.campaigns.data;
  }
  const data = (await listCampaigns()) as Campaign[];
  cache.campaigns = { data, ts: Date.now() };
  return data;
}

async function getCachedCreativeSets(): Promise<CreativeSet[]> {
  if (cache.creativeSets && Date.now() - cache.creativeSets.ts < CACHE_TTL) {
    return cache.creativeSets.data;
  }
  const all: CreativeSet[] = [];
  for (let page = 1; ; page++) {
    try {
      const csList = (await listCreativeSets(page, 100)) as CreativeSet[];
      if (!csList || csList.length === 0) break;
      all.push(...csList);
      if (csList.length < 100) break;
    } catch {
      if (page > 10) break;
    }
  }
  cache.creativeSets = { data: all, ts: Date.now() };
  return all;
}

async function getCachedReport() {
  if (cache.report && Date.now() - cache.report.ts < CACHE_TTL) {
    return cache.report.data;
  }
  const data = await getAssetReport();
  cache.report = { data, ts: Date.now() };
  return data;
}

type SendFn = (step: string, status: "progress" | "done" | "error", data?: Record<string, unknown>) => void;

// ========== PHASE 1: Upload Only ==========
async function handleUpload(
  send: SendFn,
  name: string,
  driveFolderUrl: string,
  userId: string
): Promise<{ assetId: string; assetType: string; fileName: string } | null> {
  let logFileName: string | undefined;
  let logAssetType: string | undefined;
  let logUploadId: string | undefined;
  let logError: string | undefined;

  try {
    // Step 1: Parse Drive folder URL
    send("parse_url", "progress");
    const folderId = parseDriveFolderUrl(driveFolderUrl);
    send("parse_url", "done", { folderId });

    // Step 2: Search Drive recursively
    send("search_drive", "progress");
    const file = await findFileRecursive(folderId, name);
    if (!file) {
      logError = "Файл не знайдено на Google Drive";
      send("search_drive", "error", { message: logError });
      return null;
    }
    logFileName = file.name;
    const durationMs = file.videoMediaMetadata?.durationMillis
      ? Number(file.videoMediaMetadata.durationMillis)
      : undefined;
    const durationSec = durationMs ? Math.round(durationMs / 100) / 10 : undefined;
    const sizeMb = file.size ? Math.round(Number(file.size) / 1024 / 1024 * 10) / 10 : undefined;
    // Розміри: відео → videoMediaMetadata, статика → imageMediaMetadata
    const width = file.videoMediaMetadata?.width || file.imageMediaMetadata?.width;
    const height = file.videoMediaMetadata?.height || file.imageMediaMetadata?.height;
    const isVideo = file.mimeType?.startsWith("video/") || /\.(mp4|mov)$/i.test(file.name);
    send("search_drive", "done", {
      fileName: file.name,
      fileId: file.id,
      ...(durationSec !== undefined && { durationSec }),
      ...(sizeMb !== undefined && { sizeMb }),
      ...(width && height && { resolution: `${width}x${height}` }),
    });

    // AppLovin ліміти — фейлим раніше з ясною помилкою
    const MAX_VIDEO_SEC = 60;
    const MIN_PIXELS_SHORT_SIDE = 720;
    const MAX_PIXELS = 4096;

    if (isVideo && durationSec !== undefined && durationSec > MAX_VIDEO_SEC) {
      logError = `Відео задовге: ${durationSec}с (максимум ${MAX_VIDEO_SEC}с для AppLovin)`;
      send("search_drive", "error", { message: logError });
      return null;
    }
    if (width && height) {
      const shortSide = Math.min(width, height);
      const longSide = Math.max(width, height);
      if (shortSide < MIN_PIXELS_SHORT_SIDE) {
        logError = `Замала роздільна здатність: ${width}x${height} (мінімум ${MIN_PIXELS_SHORT_SIDE}px по короткій стороні)`;
        send("search_drive", "error", { message: logError });
        return null;
      }
      if (longSide > MAX_PIXELS) {
        logError = `Завелика роздільна здатність: ${width}x${height} (максимум ${MAX_PIXELS}px по довгій стороні)`;
        send("search_drive", "error", { message: logError });
        return null;
      }
    }

    // Step 3: Check if asset exists or download
    send("download", "progress");

    let uploadedAsset: { id: string; asset_type: string; [key: string]: unknown } | null = null;
    try {
      uploadedAsset = await findAssetByName(file.name, 1, 0);
      send("download", "done", { status: "Asset вже існує в AppLovin", assetId: uploadedAsset.id });
    } catch {
      // Asset не знайдено — треба завантажити
    }

    let assetType: import("@/lib/applovin-reporting").AssetType;

    if (!uploadedAsset) {
      const { buffer, mimeType } = await downloadDriveFile(file.id);
      assetType = detectAssetType(file.name, mimeType);
      logAssetType = assetType;
      send("download", "done", { size: buffer.byteLength, assetType, mimeType });

      // Resize статики до 1080x1920 (або 1920x1080 для ландшафту), якщо вона
      // ще не такого розміру. AppLovin вимагає саме ці dimensions для статики.
      let uploadBuffer: ArrayBuffer = buffer;
      if (assetType === "image") {
        try {
          const resizeResult = await resizeStaticToAppLovinSpec(buffer);
          uploadBuffer = resizeResult.buffer;
          if (resizeResult.resized) {
            send("download", "done", {
              size: uploadBuffer.byteLength,
              assetType,
              mimeType,
              resized: `${resizeResult.fromWidth}x${resizeResult.fromHeight} → ${resizeResult.toWidth}x${resizeResult.toHeight}`,
            });
          }
        } catch (e) {
          // Resize впав — заливаємо оригінал, AppLovin сам скаже якщо не пройде
          send("download", "done", {
            size: buffer.byteLength,
            assetType,
            mimeType,
            resizeError: e instanceof Error ? e.message : "resize failed",
          });
        }
      }

      // Step 4: Upload to AppLovin
      send("upload", "progress");
      const uploadResult = await uploadAsset(uploadBuffer, file.name, mimeType);
      send("upload", "done", {
        status: "Очікування обробки...",
        uploadId: uploadResult.upload_id,
        // Якщо AppLovin повертає помилку в успішній відповіді (rare) — буде видно
        uploadResponse: uploadResult,
      });

      // Швидка спроба знайти assetId — щоб не з'їсти Vercel-бюджет 60с.
      // Якщо не знайдено — Phase 2 (handleCreate) дочекається його через свій findAssetByName.
      try {
        const found = await findAssetByName(file.name, 3, 2000);
        uploadedAsset = found;
        send("upload", "done", { assetId: found.id, assetType: found.asset_type, assetStatus: found.status });
      } catch {
        uploadedAsset = { id: "", asset_type: assetType, status: "PROCESSING", resource_type: assetType, name: file.name };
        send("upload", "done", { uploadId: uploadResult.upload_id, status: "AppLovin ще обробляє — assetId забере Phase 2" });
      }
    } else {
      const at = uploadedAsset.asset_type?.toString().toLowerCase() || "";
      if (at.includes("vid")) assetType = "video";
      else if (at.includes("html") || at.includes("hosted")) assetType = "html";
      else assetType = "image";
      logAssetType = assetType;
      send("upload", "done", { assetId: uploadedAsset.id, assetType: uploadedAsset.asset_type, assetStatus: uploadedAsset.status, status: "Використано існуючий" });
    }

    logUploadId = uploadedAsset.id;

    // Сигнал фронтенду що upload завершено з даними для фази create
    const assetStatus = String(uploadedAsset.status || "UNKNOWN");
    send("upload_done", "done", {
      assetId: uploadedAsset.id,
      assetType: assetType,
      fileName: file.name,
      assetStatus,
    });

    return { assetId: uploadedAsset.id, assetType: assetType, fileName: file.name };
  } catch (e) {
    logError = e instanceof Error ? e.message : "Невідома помилка";
    send("error", "error", { message: logError });
    return null;
  } finally {
    try {
      await prisma.smartCreativeLog.create({
        data: {
          userId,
          name,
          driveFolderUrl,
          fileName: logFileName,
          assetType: logAssetType,
          uploadId: logUploadId,
          status: logError ? "ERROR" : "SUCCESS",
          error: logError,
          campaignsCount: 0,
          createdCount: 0,
          details: {},
        },
      });
    } catch {
      // don't fail
    }
  }
}

// ========== PHASE 2: Create Creative Sets ==========
async function handleCreate(
  send: SendFn,
  name: string,
  driveFolderUrl: string,
  assetId: string,
  assetType: import("@/lib/applovin-reporting").AssetType,
  fileName: string,
  userId: string,
  ip: string
): Promise<void> {
  let logAngle: string | undefined;
  let logCampaignsCount = 0;
  let logCreatedCount = 0;
  let logError: string | undefined;
  let logDetails: Record<string, unknown> = {};

  try {
    // Step: Check approval status
    send("approval_check", "progress");
    let approvedAsset: { id: string; status: string; [key: string]: unknown };
    try {
      // Шукаємо asset з ACTIVE статусом (з ретраями для очікування апруву)
      approvedAsset = await findAssetByName(fileName, 10, 5000);
      // Якщо REJECTED — пропускаємо повністю, не створюємо креативні сети
      if (approvedAsset.status?.toUpperCase() === "REJECTED") {
        logError = "Asset відхилено AppLovin (REJECTED), пропускаємо створення сетів";
        send("approval_check", "error", { message: logError, assetStatus: approvedAsset.status });
        return;
      }

      if (approvedAsset.status !== "ACTIVE") {
        send("approval_check", "done", { status: approvedAsset.status, warning: "Asset ще не ACTIVE, але спробуємо створити" });
      } else {
        send("approval_check", "done", { status: "ACTIVE", assetId: approvedAsset.id });
      }
      // Використовуємо ID з актуального пошуку
      assetId = approvedAsset.id;
    } catch {
      send("approval_check", "error", { message: "Asset не знайдено або ще не апрувлено" });
      logError = "Asset не знайдено або ще не апрувлено";
      return;
    }

    // Step: Extract angle
    send("extract_angle", "progress");
    const angle = extractAngle(name);
    logAngle = angle;
    send("extract_angle", "done", { angle });

    // Step: Get report + complementary assets
    send("report", "progress");
    const report = await getCachedReport();
    const allAssetsList = await listAssets();
    const topAssets = findTopComplementaryAssets(report, angle, assetType, allAssetsList);
    const neededTypes: Array<"video" | "image" | "html"> =
      assetType === "video" ? ["html", "image"] : ["video"];
    if (topAssets.length === 0) {
      logError = `Не знайдено комплементарних ассетів з кутом _${angle}_`;
      send("report", "error", { message: logError });
      return;
    }
    // Розбивка по типах щоб одразу видно якщо якогось не добралось до 10
    const countByType = topAssets.reduce<Record<string, number>>((acc, a) => {
      const t = neededTypes.find((nt) =>
        allAssetsList.find((x) => x.id === a.asset_id)?.resource_type?.toLowerCase() === nt
      ) || "unknown";
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});
    send("report", "done", {
      topAssetsCount: topAssets.length,
      countByType,
      poolSize: allAssetsList.length,
      topAssets: topAssets.map((a) => ({
        name: a.asset_name,
        id: a.asset_id,
        spend: a.cost,
        impressions: a.impressions,
      })),
    });

    // Step: Find campaigns
    send("find_campaigns", "progress");
    const campaignsData = await getCachedCampaigns();

    const campaignTypeMap = new Map<string, string>();
    const campaignNameMap = new Map<string, string>();
    for (const c of campaignsData) {
      campaignTypeMap.set(c.id, c.type as string || "APP");
      campaignNameMap.set(c.id, (c.name as string || "").toLowerCase());
    }

    // Маппінг angle → ключове слово в назві кампанії
    const angleToCampaignKeyword: Record<string, string> = {
      pl: "past-life",
      au: "aura",
      ss: "soulmate",
      ch: "chats",
    };

    const allCreativeSets = await getCachedCreativeSets();

    const anglePattern = new RegExp(`_${angle}_`, "i");
    const campaignIdsWithAngle = new Set<string>();
    for (const cs of allCreativeSets) {
      if (anglePattern.test(cs.name || "") && cs.campaign_id) {
        campaignIdsWithAngle.add(cs.campaign_id as string);
      }
    }

    // Фільтруємо: кампанія має мати angle в креативах + правильне ключове слово в назві
    const campaignKeyword = angleToCampaignKeyword[angle.toLowerCase()];
    const matchingCampaignIds = Array.from(campaignIdsWithAngle).filter((id) => {
      if (!campaignNameMap.has(id)) return false;
      // Якщо є маппінг для цього angle — перевіряємо назву кампанії
      if (campaignKeyword) {
        return campaignNameMap.get(id)!.includes(campaignKeyword);
      }
      // Для інших angles — без додаткового фільтру
      return true;
    });

    if (matchingCampaignIds.length === 0) {
      const keywordHint = campaignKeyword ? ` (кампанія має містити "${campaignKeyword}")` : "";
      logError = `Не знайдено кампаній з кутом _${angle}_${keywordHint}`;
      send("find_campaigns", "error", { message: logError });
      return;
    }
    logCampaignsCount = matchingCampaignIds.length;
    send("find_campaigns", "done", {
      count: matchingCampaignIds.length,
      campaignIds: matchingCampaignIds,
    });

    // Step: Create creative sets
    send("create_sets", "progress");
    const results: Array<{ campaignId: string; result: unknown; attachedCount?: number; expectedCount?: number }> = [];
    const creativeSetName = fileName.trim().replace(/\.[^.]+$/, "");

    // Всі топ ассети йдуть в creative set разом з uploaded ассетом
    const complementaryAssetIds = topAssets.map((a) => ({ id: a.asset_id }));

    // Перевірка дублікатів: чи вже є creative set з таким ім'ям у кожній кампанії
    const existingNames = new Set<string>();
    for (const cs of allCreativeSets) {
      if (cs.name && cs.campaign_id) {
        existingNames.add(`${cs.campaign_id}::${cs.name.trim()}`);
      }
    }

    let skippedCount = 0;

    for (let ci = 0; ci < matchingCampaignIds.length; ci++) {
      const campaignId = matchingCampaignIds[ci];

      // Пропустити якщо creative set з таким ім'ям вже існує в цій кампанії
      const key = `${campaignId}::${creativeSetName}`;
      if (existingNames.has(key)) {
        skippedCount++;
        results.push({ campaignId, result: { skipped: true, reason: "Креатив з такою назвою вже існує в цій кампанії" } });
        continue;
      }

      if (ci > 0) await new Promise((r) => setTimeout(r, 500));

      let retries = 2;
      while (retries >= 0) {
        try {
          const assets = [
            { id: assetId },
            ...complementaryAssetIds,
          ];

          const campaignType = campaignTypeMap.get(campaignId) || "APP";

          const result = await createCreativeSet({
            campaign_id: campaignId,
            type: campaignType,
            name: creativeSetName,
            assets,
          });
          // Перевірка чи всі ассети реально додались — AppLovin може мовчки ігнорувати
          // (наприклад якщо формат payload неправильний для додаткових ассетів)
          const r = result as { assets?: unknown[]; creatives?: unknown[]; creative_ids?: unknown[] };
          const arr = r.assets ?? r.creatives ?? r.creative_ids;
          const attachedCount = Array.isArray(arr) ? arr.length : undefined;
          const expectedCount = assets.length;
          if (attachedCount !== undefined && attachedCount < expectedCount) {
            send("create_sets", "progress", {
              warning: `Очікувалось ${expectedCount} ассетів у сеті, AppLovin прикріпив ${attachedCount}`,
              campaignId,
              expectedCount,
              attachedCount,
              responseShape: Object.keys(result as object),
            });
          }
          results.push({ campaignId, result, attachedCount, expectedCount });
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Помилка створення";
          if (retries > 0 && (msg.includes("500") || msg.includes("429"))) {
            retries--;
            const delay = msg.includes("429") ? 10000 : 3000;
            await new Promise((r) => setTimeout(r, delay));
          } else {
            results.push({ campaignId, result: { error: msg } });
            send("create_sets", "progress", {
              errorDetail: msg,
              campaignId,
              assetId,
              complementaryCount: complementaryAssetIds.length,
            });
            break;
          }
        }
      }
    }

    logCreatedCount = results.filter(
      (r) => !(r.result as { error?: string }).error && !(r.result as { skipped?: boolean }).skipped
    ).length;
    const failedCount = results.filter((r) => (r.result as { error?: string }).error).length;
    logDetails = {
      results,
      complementaryAssets: topAssets.map((a) => ({ id: a.asset_id, name: a.asset_name, spend: a.cost })),
      skippedCount,
    };

    // Перший унікальний текст помилки від AppLovin — щоб не копати в details
    const firstApiError = results
      .map((r) => (r.result as { error?: string }).error)
      .find((e): e is string => typeof e === "string" && e.length > 0);

    if (skippedCount > 0 && skippedCount === results.length) {
      logError = `Всі ${skippedCount} креативних сетів вже існують (дублікати)`;
    } else if (failedCount > 0) {
      const baseMsg = failedCount === results.length
        ? `Всі ${failedCount} креативних сетів не вдалось створити`
        : `${failedCount} з ${results.length} креативних сетів не вдалось створити`;
      logError = firstApiError ? `${baseMsg}. AppLovin: ${firstApiError}` : baseMsg;
    }

    const hasErrors = failedCount > 0 || (skippedCount > 0 && logCreatedCount === 0);

    send("create_sets", hasErrors ? "error" : "done", {
      created: logCreatedCount,
      skipped: skippedCount,
      failed: failedCount,
      details: results,
    });

    await logAudit({
      userId,
      action: "SMART_CREATIVE",
      entity: "creative_set",
      details: {
        name,
        angle,
        assetType,
        assetId,
        complementaryAssets: topAssets.map((a) => a.asset_id),
        campaignsCount: matchingCampaignIds.length,
        createdCount: logCreatedCount,
      },
      ip,
    });

    if (failedCount === 0) {
      send("complete", "done", { message: `Створено ${logCreatedCount} креативних сетів!` });
    } else {
      send("complete", "error", { message: logError });
    }
  } catch (e) {
    logError = e instanceof Error ? e.message : "Невідома помилка";
    send("error", "error", { message: logError });
  } finally {
    try {
      await prisma.smartCreativeLog.create({
        data: {
          userId,
          name,
          driveFolderUrl,
          fileName,
          assetType: assetType,
          angle: logAngle,
          uploadId: assetId,
          status: logError ? "ERROR" : "SUCCESS",
          error: logError,
          campaignsCount: logCampaignsCount,
          createdCount: logCreatedCount,
          details: logDetails as object,
        },
      });
    } catch {
      // don't fail
    }
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return jsonError("Не авторизовано", 401);

  const body = await req.json();
  const parsed = smartCreativeSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.issues[0].message);

  const { name, driveFolderUrl, mode, assetId, assetType, fileName } = parsed.data;

  // Preflight: лише шукає файл в Drive і повертає метадані (без upload)
  if (mode === "preflight") {
    try {
      const folderId = parseDriveFolderUrl(driveFolderUrl);
      const file = await findFileRecursive(folderId, name);
      if (!file) {
        return Response.json({ found: false }, { status: 200 });
      }
      const isVideo = file.mimeType?.startsWith("video/") || /\.(mp4|mov)$/i.test(file.name);
      const durationMs = file.videoMediaMetadata?.durationMillis
        ? Number(file.videoMediaMetadata.durationMillis)
        : undefined;
      const durationSec = durationMs ? Math.round(durationMs / 100) / 10 : undefined;
      const sizeMb = file.size ? Math.round(Number(file.size) / 1024 / 1024 * 10) / 10 : undefined;
      return Response.json({
        found: true,
        fileName: file.name,
        isVideo,
        durationSec,
        sizeMb,
        width: file.videoMediaMetadata?.width,
        height: file.videoMediaMetadata?.height,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Помилка preflight";
      return Response.json({ found: false, error: msg }, { status: 200 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send: SendFn = (step, status, data?) => {
        const msg = `data: ${JSON.stringify({ step, status, data })}\n\n`;
        controller.enqueue(encoder.encode(msg));
      };

      if (mode === "create") {
        // Phase 2: Create creative sets only — fileName обов'язковий, assetId опціональний
        // (Phase 1 могла не встигнути знайти assetId через Vercel timeout, тут досить чекатимемо)
        if (!fileName) {
          send("error", "error", { message: "fileName обов'язковий для mode=create" });
          controller.close();
          return;
        }
        // Нормалізуємо assetType (AppLovin може повертати "VIDEO"/"IMAGE" замість "video"/"image").
        // assetType може бути порожнім якщо Phase 1 не встигла — тоді розрахуємо з fileName/mimeType.
        const normalizedType = (assetType || "").toLowerCase();
        let resolvedType: import("@/lib/applovin-reporting").AssetType;
        if (normalizedType.includes("vid")) resolvedType = "video";
        else if (normalizedType.includes("html") || normalizedType.includes("hosted")) resolvedType = "html";
        else if (normalizedType.includes("image")) resolvedType = "image";
        else {
          // Фолбек по назві файлу
          if (/\.(mp4|mov)$/i.test(fileName)) resolvedType = "video";
          else if (/\.html?$/i.test(fileName) || fileName.toLowerCase().includes("html")) resolvedType = "html";
          else resolvedType = "image";
        }
        await handleCreate(send, name, driveFolderUrl, assetId || "", resolvedType, fileName, user.userId, getClientIp(req));
      } else {
        // Phase 1 (default): Upload only
        await handleUpload(send, name, driveFolderUrl, user.userId);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
