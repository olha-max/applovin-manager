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
  videoMediaMetadata?: { width: number; height: number };
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
        "nextPageToken,files(id,name,mimeType,videoMediaMetadata,imageMediaMetadata)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);

    let res: Response | null = null;
    for (let retry = 0; retry <= 2; retry++) {
      res = await fetch(`${DRIVE_API_BASE}/files?${params}`, {
        cache: "no-store",
      });
      if (res.ok || (res.status !== 403 && res.status !== 429)) break;
      await new Promise((r) => setTimeout(r, (retry + 1) * 5000));
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
  const prefix = searchName.trim().slice(0, 20).toLowerCase();
  return fileName.trim().toLowerCase().startsWith(prefix);
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

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${DRIVE_API_BASE}/files/${fileId}?${params}`, {
      cache: "no-store",
    });

    if (res.ok) {
      const mimeType = res.headers.get("content-type") || "application/octet-stream";
      const buffer = await res.arrayBuffer();
      return { buffer, mimeType };
    }

    // Retry on 403 (rate limit) and 429
    if ((res.status === 403 || res.status === 429) && attempt < maxRetries) {
      const delay = (attempt + 1) * 5000; // 5s, 10s, 15s
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();
    throw new Error(`Google Drive download error (${res.status}): ${text}`);
  }

  throw new Error("Google Drive download: max retries reached");
}
