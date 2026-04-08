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

// Фільтрує ассети по angle та типу
// Angle може бути в різних позиціях: _video_ss_, _video_strl_ss_, тощо
// Тому шукаємо _${angle}_ де завгодно в назві, а тип визначаємо окремо
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

export function findTopComplementaryAssets(
  report: AssetReportEntry[],
  angle: string,
  uploadedType: AssetType
): AssetReportEntry[] {
  // Report вже агрегований по asset_id (без creative_set колонок)
  // Просто фільтруємо по angle + типу і беремо топ по spend

  if (uploadedType === "image" || uploadedType === "html") {
    // Статика/HTML → 5 топ відео по spend
    const videos = filterByAngleAndType(report, angle, "video");
    videos.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    return videos.slice(0, 5);
  } else {
    // Відео → 5 топ interactives (HTML) + 5 топ statics по spend
    const htmlAssets = filterByAngleAndType(report, angle, "html");
    htmlAssets.sort((a, b) => (b.cost || 0) - (a.cost || 0));

    const imageAssets = filterByAngleAndType(report, angle, "image");
    imageAssets.sort((a, b) => (b.cost || 0) - (a.cost || 0));

    return [...htmlAssets.slice(0, 5), ...imageAssets.slice(0, 5)];
  }
}
