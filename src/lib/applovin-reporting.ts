import "server-only";

const REPORT_URL = "https://r.applovin.com/assetReport";

function getReportKey(): string {
  const key = process.env.APPLOVIN_REPORT_KEY;
  if (!key) throw new Error("APPLOVIN_REPORT_KEY is not configured");
  return key;
}

export interface AssetReportEntry {
  asset_id: string;
  asset_name: string;
  impressions: number;
  clicks: number;
  cost: number;
  ctr: number;
}

export type AssetType = "video" | "image" | "html";

export async function getAssetReport(): Promise<AssetReportEntry[]> {
  const params = new URLSearchParams({
    api_key: getReportKey(),
    range: "last_month",
    format: "json",
    // Без creative_set колонок — API агрегує дані по кожному ассету окремо
    columns: "asset_id,asset_name,impressions,clicks,cost,ctr",
    sort_cost: "desc",
  });

  const res = await fetch(`${REPORT_URL}?${params}`, { cache: "no-store" });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AppLovin Reporting API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  // AppLovin повертає числа як strings — конвертуємо
  return (data.results || []).map((r: Record<string, unknown>) => ({
    ...r,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    cost: Number(r.cost) || 0,
    ctr: Number(r.ctr) || 0,
  }));
}

export function extractAngle(name: string): string {
  const match = name.match(/_(static|video)_([a-zA-Z]+)_/i);
  if (!match) throw new Error("Не вдалося визначити кут (angle) з назви. Очікується формат _static_xx_ або _video_xx_");
  return match[2].toLowerCase();
}

export function detectAssetType(fileName: string, mimeType: string): AssetType {
  if (mimeType.startsWith("video/") || /\.(mp4|mov)$/i.test(fileName)) return "video";
  if (mimeType === "text/html" || /\.html?$/i.test(fileName)) return "html";
  return "image";
}

// Інтерфейс ассету з AppLovin
export interface AppLovinAssetLite {
  id: string;
  name: string;
  status: string;
  asset_type: string;
  resource_type: string;
  upload_time?: string;
}

// Тип ассета з AppLovin API. resource_type — канонічне поле API
// зі значеннями "video"/"image"/"html" (image=static, html=interstitial).
// Фолбек на здогадку по назві лише якщо resource_type не заповнений.
function assetTypeFromApi(asset: AppLovinAssetLite): AssetType | null {
  const rt = (asset.resource_type || "").toString().toLowerCase().trim();
  if (rt === "video") return "video";
  if (rt === "image") return "image";
  if (rt === "html") return "html";
  // resource_type порожній — нема надійного способу розрізнити static від interstitial
  // (обидва часто мають "_static_" в назві). Не включаємо такі ассети взагалі.
  return null;
}

// Бере N ассетів заданого типу для angle: спочатку топ по spend, добиває найновішими.
// Тип ВИЗНАЧАЄТЬСЯ ТІЛЬКИ через resource_type AppLovin (не по назві!),
// бо static і interstitial мають однакову конвенцію назв.
function pickAssets(
  allAssets: AppLovinAssetLite[],
  report: AssetReportEntry[],
  angle: string,
  targetType: AssetType,
  limit: number
): AssetReportEntry[] {
  const anglePattern = new RegExp(`_${angle}_`, "i");
  const spendMap = new Map<string, number>();
  for (const r of report) spendMap.set(r.asset_id, r.cost || 0);

  // Кандидати: ACTIVE + правильний angle + правильний resource_type
  const candidates = allAssets.filter((a) => {
    if (a.status !== "ACTIVE") return false;
    if (!anglePattern.test(a.name || "")) return false;
    return assetTypeFromApi(a) === targetType;
  });

  // Сортуємо: spend desc, потім upload_time desc (найновіші)
  candidates.sort((a, b) => {
    const sb = spendMap.get(b.id) || 0;
    const sa = spendMap.get(a.id) || 0;
    if (sb !== sa) return sb - sa;
    return (b.upload_time || "").localeCompare(a.upload_time || "");
  });

  return candidates.slice(0, limit).map((a) => ({
    asset_id: a.id,
    asset_name: a.name,
    impressions: 0,
    clicks: 0,
    cost: spendMap.get(a.id) || 0,
    ctr: 0,
  }));
}

export function findTopComplementaryAssets(
  report: AssetReportEntry[],
  angle: string,
  uploadedType: AssetType,
  allAssets: AppLovinAssetLite[] = []
): AssetReportEntry[] {
  const LIMIT = 10;

  if (uploadedType === "image" || uploadedType === "html") {
    // Статика/HTML → 10 відео
    return pickAssets(allAssets, report, angle, "video", LIMIT);
  } else {
    // Відео → 10 interstitials (html) + 10 статик (image)
    const htmlAssets = pickAssets(allAssets, report, angle, "html", LIMIT);
    const imageAssets = pickAssets(allAssets, report, angle, "image", LIMIT);
    return [...htmlAssets, ...imageAssets];
  }
}
