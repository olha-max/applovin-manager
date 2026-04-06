import { NextRequest } from "next/server";
import { smartCreativeSchema } from "@/lib/validators";
import { getAuthUser, jsonError, getClientIp } from "@/lib/api-utils";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { parseDriveFolderUrl, findFileRecursive, downloadDriveFile } from "@/lib/google-drive";
import {
  uploadAsset,
  findAssetByName,
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
    send("search_drive", "done", { fileName: file.name, fileId: file.id });

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

      // Step 4: Upload to AppLovin
      send("upload", "progress");
      const uploadResult = await uploadAsset(buffer, file.name, mimeType);
      send("upload", "done", { status: "Очікування обробки...", uploadId: uploadResult.upload_id });

      // Шукаємо реальний asset id
      uploadedAsset = await findAssetByName(file.name);
      send("upload", "done", { assetId: uploadedAsset.id, assetType: uploadedAsset.asset_type, assetStatus: uploadedAsset.status });
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
    const topAssets = findTopComplementaryAssets(report, angle, assetType);
    if (topAssets.length === 0) {
      logError = `Не знайдено комплементарних ассетів з кутом _${angle}_`;
      send("report", "error", { message: logError });
      return;
    }
    send("report", "done", {
      topAssetsCount: topAssets.length,
      topAssetName: topAssets[0].asset_name,
      topAssetId: topAssets[0].asset_id,
      topImpressions: topAssets[0].impressions,
    });

    // Step: Find campaigns
    send("find_campaigns", "progress");
    const campaignsData = await getCachedCampaigns();
    const campaignIds = campaignsData.map((c) => c.id);

    const campaignTypeMap = new Map<string, string>();
    for (const c of campaignsData) {
      campaignTypeMap.set(c.id, c.type as string || "APP");
    }

    const allCreativeSets = await getCachedCreativeSets();

    const anglePattern = new RegExp(`_(static|video)_${angle}_`, "i");
    const campaignIdsWithAngle = new Set<string>();
    for (const cs of allCreativeSets) {
      if (anglePattern.test(cs.name || "") && cs.campaign_id) {
        campaignIdsWithAngle.add(cs.campaign_id as string);
      }
    }
    const matchingCampaignIds = Array.from(campaignIdsWithAngle).filter((id) =>
      campaignIds.includes(id)
    );

    if (matchingCampaignIds.length === 0) {
      logError = `Не знайдено кампаній з кутом _${angle}_ в креативах`;
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
    const results: Array<{ campaignId: string; result: unknown }> = [];
    const topAsset = topAssets[0];

    for (let ci = 0; ci < matchingCampaignIds.length; ci++) {
      const campaignId = matchingCampaignIds[ci];
      if (ci > 0) await new Promise((r) => setTimeout(r, 2000));

      let retries = 2;
      while (retries >= 0) {
        try {
          const assets = [
            { id: assetId },
            { id: topAsset.asset_id },
          ];

          const creativeSetName = fileName.trim().replace(/\.[^.]+$/, "");
          const campaignType = campaignTypeMap.get(campaignId) || "APP";

          const result = await createCreativeSet({
            campaign_id: campaignId,
            type: campaignType,
            name: creativeSetName,
            assets,
          });
          results.push({ campaignId, result });
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
              topAssetId: topAsset.asset_id,
            });
            break;
          }
        }
      }
    }

    logCreatedCount = results.filter((r) => !(r.result as { error?: string }).error).length;
    const failedCount = results.filter((r) => (r.result as { error?: string }).error).length;
    logDetails = { results, topAssetId: topAsset.asset_id, topAssetName: topAsset.asset_name };

    if (failedCount > 0) {
      logError = failedCount === results.length
        ? `Всі ${failedCount} креативних сетів не вдалось створити`
        : `${failedCount} з ${results.length} креативних сетів не вдалось створити`;
    }

    send("create_sets", failedCount > 0 ? "error" : "done", {
      created: logCreatedCount,
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
        topComplementaryAsset: topAsset.asset_id,
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send: SendFn = (step, status, data?) => {
        const msg = `data: ${JSON.stringify({ step, status, data })}\n\n`;
        controller.enqueue(encoder.encode(msg));
      };

      if (mode === "create") {
        // Phase 2: Create creative sets only
        if (!assetId || !assetType || !fileName) {
          send("error", "error", { message: "assetId, assetType та fileName обов'язкові для mode=create" });
          controller.close();
          return;
        }
        // Нормалізуємо assetType (AppLovin може повертати "VIDEO"/"IMAGE" замість "video"/"image")
        const normalizedType = assetType.toLowerCase();
        const resolvedType: import("@/lib/applovin-reporting").AssetType =
          normalizedType.includes("vid") ? "video" :
          normalizedType.includes("html") || normalizedType.includes("hosted") ? "html" :
          "image";
        await handleCreate(send, name, driveFolderUrl, assetId, resolvedType, fileName, user.userId, getClientIp(req));
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
