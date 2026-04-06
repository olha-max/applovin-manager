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
  return data.results || [];
}

export function extractAngle(name: string): string {
  // Angle стоїть одразу після _static_ або _video_
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
  if (lower.includes("_video_")) return "video";
  if (lower.includes("_static_")) return "image";
  if (lower.includes(".html")) return "html";
  if (lower.includes(".mp4") || lower.includes(".mov")) return "video";
  // fallback: якщо немає маркера, вважаємо image (end card)
  return "image";
}

export function findTopComplementaryAssets(
  report: AssetReportEntry[],
  angle: string,
  uploadedType: AssetType
): AssetReportEntry[] {
  // Angle стоїть одразу після _static_ або _video_
  const anglePattern = new RegExp(`_(static|video)_${angle}_`, "i");

  // Filter: matching angle + complementary type
  const filtered = report.filter((entry) => {
    const nameHasAngle = anglePattern.test(entry.asset_name || "");
    if (!nameHasAngle) return false;

    const entryType = guessAssetType(entry.asset_name);
    if (uploadedType === "video") {
      // Looking for end cards (images or HTML)
      return entryType === "image" || entryType === "html";
    } else {
      // Looking for videos
      return entryType === "video";
    }
  });

  // Sort by impressions descending
  filtered.sort((a, b) => (b.impressions || 0) - (a.impressions || 0));

  return filtered;
}
