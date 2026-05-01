import "server-only";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

function getApiKey(): string {
  const key = process.env.GOOGLE_DRIVE_API_KEY;
  if (!key) throw new Error("GOOGLE_DRIVE_API_KEY is not configured");
  return key;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  videoMediaMetadata?: { width: number; height: number; durationMillis?: string };
  imageMediaMetadata?: { width: number; height: number };
}

export function parseDriveFolderUrl(url: string): string {
  const match = url.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error("Невірне посилання на Google Drive папку");
  return match[1];
}

async function listFilesInFolder(folderId: string): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      key: getApiKey(),
      fields:
        "nextPageToken,files(id,name,mimeType,size,videoMediaMetadata,imageMediaMetadata)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);

    let res: Response | null = null;
    for (let retry = 0; retry <= 4; retry++) {
      res = await fetch(`${DRIVE_API_BASE}/files?${params}`, {
        cache: "no-store",
      });
      if (res.ok || (res.status !== 403 && res.status !== 429)) break;
      const baseDelay = Math.pow(2, retry) * 5000; // 5s, 10s, 20s, 40s, 80s
      const jitter = Math.random() * 2000;
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }

    if (!res || !res.ok) {
      const text = await res?.text() || "Unknown error";
      throw new Error(`Google Drive API error (${res?.status}): ${text}`);
    }

    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

function isPortrait(file: DriveFile): boolean {
  const meta = file.videoMediaMetadata || file.imageMediaMetadata;
  if (!meta || !meta.width || !meta.height) return true; // assume portrait if no metadata
  return meta.height > meta.width;
}

function nameMatchesPrefix(fileName: string, searchName: string): boolean {
  const fileLower = fileName.trim().toLowerCase();
  const searchLower = searchName.trim().toLowerCase();
  // Якщо в назві є MCS-код (MCS-1234) — матчимо тільки по ньому, ігноруючи решту назви.
  // Це дозволяє коли в Drive файл названо трохи інакше від того що вводиш.
  const mcsCode = searchLower.match(/^(mcs-\d+)/);
  if (mcsCode) {
    return fileLower.startsWith(mcsCode[1] + "_") || fileLower.startsWith(mcsCode[1] + ".");
  }
  // Фолбек: перші 20 символів
  return fileLower.startsWith(searchLower.slice(0, 20));
}

export async function findFileRecursive(
  folderId: string,
  searchName: string
): Promise<DriveFile | null> {
  const files = await listFilesInFolder(folderId);

  const folders: DriveFile[] = [];
  for (const file of files) {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      folders.push(file);
      continue;
    }

    if (nameMatchesPrefix(file.name, searchName) && isPortrait(file)) {
      return file;
    }
  }

  // Recurse into subfolders
  for (const folder of folders) {
    const found = await findFileRecursive(folder.id, searchName);
    if (found) return found;
  }

  return null;
}

export async function downloadDriveFile(
  fileId: string
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const params = new URLSearchParams({
    alt: "media",
    key: getApiKey(),
  });

  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${DRIVE_API_BASE}/files/${fileId}?${params}`, {
      cache: "no-store",
    });

    if (res.ok) {
      const mimeType = res.headers.get("content-type") || "application/octet-stream";
      const buffer = await res.arrayBuffer();
      return { buffer, mimeType };
    }

    // Retry on 403 (rate limit) and 429 — exponential backoff з jitter
    if ((res.status === 403 || res.status === 429) && attempt < maxRetries) {
      const baseDelay = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s, 40s, 80s
      const jitter = Math.random() * 2000;
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
      continue;
    }

    const text = await res.text();
    throw new Error(`Google Drive download error (${res.status}): ${text}`);
  }

  throw new Error("Google Drive download: max retries reached");
}
