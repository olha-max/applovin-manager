import "server-only";

const BASE_URL = "https://api.ads.axon.ai/manage/v1/";
const ACCOUNT_ID = "913452620";

function getApiKey(): string {
  const key = process.env.APPLOVIN_API_KEY;
  if (!key) throw new Error("APPLOVIN_API_KEY is not configured");
  return key;
}

async function applovinFetch<T>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(endpoint, BASE_URL);
  url.searchParams.set("account_id", ACCOUNT_ID);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: getApiKey(),
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Унікальний параметр щоб Next.js не кешував відповіді
    const fetchUrl = new URL(url.toString());
    fetchUrl.searchParams.set("_t", `${Date.now()}_${attempt}`);

    const res = await fetch(fetchUrl.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      next: { revalidate: 0 },
    } as RequestInit);

    if (res.ok) return res.json();

    const text = await res.text();
    const headerError = res.headers.get("x-al-error-message") || "";
    const errorMsg = text || headerError || `HTTP ${res.status}`;

    // Retry on 429 (rate limit) and 500 (server error)
    // Менше retry для GET — якщо дані ламають API, повтор не допоможе
    const retriesLeft = method === "GET" ? Math.min(1, maxRetries - attempt) : maxRetries - attempt;
    if ((res.status === 429 || res.status === 500) && retriesLeft > 0) {
      const delay = res.status === 429 ? 10000 : 3000;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`AppLovin API error (${res.status}): ${errorMsg}`);
  }

  throw new Error("AppLovin API: max retries reached");
}

// Campaigns
export async function listCampaigns() {
  return applovinFetch("campaign/list");
}

export async function createCampaign(data: Record<string, unknown>) {
  return applovinFetch("campaign/create", "POST", data);
}

export async function updateCampaign(data: Record<string, unknown>) {
  return applovinFetch("campaign/update", "POST", data);
}

// Creative Sets
export async function listCreativeSets(page = 1, size = 100) {
  return applovinFetch(`creative_set/list`, "GET", undefined, { page: String(page), size: String(size) });
}

export async function createCreativeSet(data: Record<string, unknown>) {
  return applovinFetch("creative_set/create", "POST", data);
}

export async function updateCreativeSet(data: Record<string, unknown>) {
  return applovinFetch("creative_set/update", "POST", data);
}

export async function deleteCreativeSet(data: Record<string, unknown>) {
  return applovinFetch("creative_set/delete", "POST", data);
}

// Assets
export async function uploadAsset(
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string
): Promise<{ upload_id: string; [key: string]: unknown }> {
  const url = new URL("asset/upload", BASE_URL);
  url.searchParams.set("account_id", ACCOUNT_ID);

  const form = new FormData();
  form.append("files", new Blob([fileBuffer], { type: mimeType }), fileName);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: getApiKey() },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Asset upload error (${res.status}): ${text}`);
  }
  return res.json();
}

export interface AppLovinAsset {
  id: string;
  name: string;
  status: string;
  asset_type: string;
  resource_type: string;
  upload_time?: string;
  [key: string]: unknown;
}

export async function listAssets(): Promise<AppLovinAsset[]> {
  const allAssets: AppLovinAsset[] = [];
  const MAX_PAGES = 50; // 50 × 100 = 5000 ассетів (раніше 20 × 100 = 2000)

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL("asset/list", BASE_URL);
    url.searchParams.set("account_id", ACCOUNT_ID);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", "100");

    const res = await fetch(url.toString(), {
      headers: { Authorization: getApiKey() },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      const headerError = res.headers.get("x-al-error-message") || "";
      const errorMsg = text || headerError || `HTTP ${res.status}`;
      throw new Error(`Asset list error (${res.status}): ${errorMsg}`);
    }

    const assets: AppLovinAsset[] = await res.json();
    if (!assets || assets.length === 0) break;
    allAssets.push(...assets);
    if (assets.length < 100) break;
  }

  return allAssets;
}

// Знайти asset по імені файлу. Якщо назва починається з MCS-XXXX —
// матчимо саме по цьому коду (бо повна назва в AppLovin може відрізнятись).
// Інакше fallback на перші 20 символів.
export async function findAssetByName(
  fileName: string,
  maxRetries = 20,
  delayMs = 6000
): Promise<AppLovinAsset> {
  const nameTrimmed = fileName.trim();
  const nameLower = nameTrimmed.toLowerCase();
  const mcsCode = nameLower.match(/^(mcs-\d+)/)?.[1];
  const prefix = nameTrimmed.slice(0, 20).toLowerCase();

  const matchesByCode = (assetName: string): boolean => {
    const lower = assetName.trim().toLowerCase();
    if (mcsCode) return lower.startsWith(mcsCode + "_") || lower.startsWith(mcsCode + ".");
    return lower.startsWith(prefix);
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const assets = await listAssets();

    // Точний матч (ACTIVE)
    const exact = assets.find(
      (a) => a.name?.trim() === nameTrimmed && a.status === "ACTIVE"
    );
    if (exact) return exact;

    // По MCS-коду / префіксу (ACTIVE)
    const codeMatch = assets.find(
      (a) => a.name && matchesByCode(a.name) && a.status === "ACTIVE"
    );
    if (codeMatch) return codeMatch;

    // Без перевірки статусу (asset може ще оброблятись)
    const anyStatusExact = assets.find(
      (a) => a.name?.trim() === nameTrimmed
    );
    if (anyStatusExact) return anyStatusExact;

    const anyStatusCode = assets.find((a) => a.name && matchesByCode(a.name));
    if (anyStatusCode) return anyStatusCode;

    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Asset "${nameTrimmed}" не знайдено після завантаження (${maxRetries} спроб)`);
}

// Creative Sets by Campaign
export async function listCreativeSetsByCampaign(campaignIds: string[]) {
  const url = new URL("creative_set/list_by_campaign_id", BASE_URL);
  url.searchParams.set("account_id", ACCOUNT_ID);
  url.searchParams.set("ids", campaignIds.join(","));

  const res = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      Authorization: getApiKey(),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    const headerError = res.headers.get("x-al-error-message") || "";
    const errorMsg = text || headerError || `HTTP ${res.status}`;
    throw new Error(`AppLovin API error (${res.status}): ${errorMsg}`);
  }
  return res.json();
}
