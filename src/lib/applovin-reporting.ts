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
  campaign: string;
  campaign_id: string;
  creative_set: string;
  creative_set_id: string;
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
    columns: "asset_id,asset_name,campaign,campaign_id,creative_set,creative_set_id,impressions,clicks,cost,ctr",
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

interface AggregatedAsset extends AssetReportEntry {
  totalSpend: number;
  totalImpressions: number;
}

function aggregateByAssetId(entries: AssetReportEntry[]): AggregatedAsset[] {
  const aggregated = new Map<string, AggregatedAsset>();
  for (const entry of entries) {
    const existing = aggregated.get(entry.asset_id);
    if (existing) {
      existing.totalSpend += entry.cost || 0;
      existing.totalImpressions += entry.impressions || 0;
    } else {
      aggregated.set(entry.asset_id, {
        ...entry,
        totalSpend: entry.cost || 0,
        totalImpressions: entry.impressions || 0,
      });
    }
  }
  return Array.from(aggregated.values());
}

// Фільтрує ассети по angle та типу
function filterByAngleAndType(
  report: AssetReportEntry[],
  angle: string,
  targetType: AssetType
): AssetReportEntry[] {
  const anglePattern = new RegExp(`(?:^|_)(static|video)_${angle}_`, "i");

  return report.filter((entry) => {
    const nameHasAngle = anglePattern.test(entry.asset_name || "");
    if (!nameHasAngle) return false;
    return guessAssetType(entry.asset_name) === targetType;
  });
}

export function findTopComplementaryAssets(
  report: AssetReportEntry[],
  angle: string,
  uploadedType: AssetType
): AssetReportEntry[] {
  if (uploadedType === "image" || uploadedType === "html") {
    // Статика/HTML → 5 топ відео по spend
    const videos = filterByAngleAndType(report, angle, "video");
    const aggregated = aggregateByAssetId(videos);
    aggregated.sort((a, b) => b.totalSpend - a.totalSpend);
    return aggregated.slice(0, 5).map((r) => ({
      ...r,
      cost: r.totalSpend,
      impressions: r.totalImpressions,
    }));
  } else {
    // Відео → 5 топ interactives (HTML) + 5 топ statics по spend
    const htmlAssets = filterByAngleAndType(report, angle, "html");
    const imageAssets = filterByAngleAndType(report, angle, "image");

    const topHtml = aggregateByAssetId(htmlAssets);
    topHtml.sort((a, b) => b.totalSpend - a.totalSpend);

    const topImages = aggregateByAssetId(imageAssets);
    topImages.sort((a, b) => b.totalSpend - a.totalSpend);

    const combined = [
      ...topHtml.slice(0, 5),
      ...topImages.slice(0, 5),
    ];

    return combined.map((r) => ({
      ...r,
      cost: r.totalSpend,
      impressions: r.totalImpressions,
    }));
  }
}
