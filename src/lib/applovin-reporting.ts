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
    range: "last_7d",
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

function guessAssetType(assetName: string): AssetType {
  const lower = assetName?.toLowerCase() || "";
  if (/(?:^|_)video[_.]/.test(lower)) return "video";
  if (/(?:^|_)static[_.]/.test(lower)) return "image";
  if (lower.includes(".html")) return "html";
  if (lower.includes(".mp4") || lower.includes(".mov")) return "video";
  return "image";
}

// Фільтрує ассети з repor по angle та типу
function filterByAngleAndType(
  report: AssetReportEntry[],
  angle: string,
  targetType: AssetType
): AssetReportEntry[] {
  const anglePattern = new RegExp(`_${angle}_`, "i");

  return report.filter((entry) => {
    const name = entry.asset_name || "";
    if (!anglePattern.test(name)) return false;
    return guessAssetType(name) === targetType;
  });
}

// Інтерфейс ассету з AppLovin (для добору найновіших)
export interface AppLovinAssetLite {
  id: string;
  name: string;
  status: string;
  asset_type: string;
  resource_type: string;
  upload_time?: string;
}

// Конвертує AppLovinAsset → AssetReportEntry щоб уніфікувати формат
function assetToReportEntry(asset: AppLovinAssetLite): AssetReportEntry {
  return {
    asset_id: asset.id,
    asset_name: asset.name,
    impressions: 0,
    clicks: 0,
    cost: 0,
    ctr: 0,
  };
}

// Найновіші ассети з заданим angle і типом, які ще не в excludeIds
function findRecentAssets(
  allAssets: AppLovinAssetLite[],
  angle: string,
  targetType: AssetType,
  excludeIds: Set<string>,
  limit: number
): AssetReportEntry[] {
  const anglePattern = new RegExp(`_${angle}_`, "i");

  const matching = allAssets.filter((a) => {
    if (excludeIds.has(a.id)) return false;
    if (a.status !== "ACTIVE") return false;
    const name = a.name || "";
    if (!anglePattern.test(name)) return false;
    return guessAssetType(name) === targetType;
  });

  // Сортуємо по upload_time (найновіші перші)
  matching.sort((a, b) => {
    const ta = a.upload_time || "";
    const tb = b.upload_time || "";
    return tb.localeCompare(ta);
  });

  return matching.slice(0, limit).map(assetToReportEntry);
}

// Бере топ N по spend, добиває найновішими якщо не вистачає
function topByspendOrRecent(
  report: AssetReportEntry[],
  allAssets: AppLovinAssetLite[],
  angle: string,
  targetType: AssetType,
  limit: number
): AssetReportEntry[] {
  // Топ по spend
  const filtered = filterByAngleAndType(report, angle, targetType);
  filtered.sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const topBySpend = filtered.slice(0, limit);

  // Якщо вже маємо достатньо — повертаємо
  if (topBySpend.length >= limit) return topBySpend;

  // Добираємо найновіші (виключаючи вже відібрані)
  const excludeIds = new Set(topBySpend.map((a) => a.asset_id));
  const needMore = limit - topBySpend.length;
  const recent = findRecentAssets(allAssets, angle, targetType, excludeIds, needMore);

  return [...topBySpend, ...recent];
}

export function findTopComplementaryAssets(
  report: AssetReportEntry[],
  angle: string,
  uploadedType: AssetType,
  allAssets: AppLovinAssetLite[] = []
): AssetReportEntry[] {
  const LIMIT = 10;

  if (uploadedType === "image" || uploadedType === "html") {
    // Статика/HTML → 10 топ відео (добираємо найновішими якщо менше)
    return topByspendOrRecent(report, allAssets, angle, "video", LIMIT);
  } else {
    // Відео → 10 топ interactives (HTML) + 10 топ statics
    const htmlAssets = topByspendOrRecent(report, allAssets, angle, "html", LIMIT);
    const imageAssets = topByspendOrRecent(report, allAssets, angle, "image", LIMIT);
    return [...htmlAssets, ...imageAssets];
  }
}
