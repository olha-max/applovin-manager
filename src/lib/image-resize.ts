import "server-only";
import sharp from "sharp";

const TARGET_PORTRAIT_W = 1080;
const TARGET_PORTRAIT_H = 1920;
const TARGET_LANDSCAPE_W = 1920;
const TARGET_LANDSCAPE_H = 1080;

export interface ResizeResult {
  buffer: ArrayBuffer;
  resized: boolean;
  fromWidth?: number;
  fromHeight?: number;
  toWidth?: number;
  toHeight?: number;
}

// Resize статика до 1080x1920 (портрет) або 1920x1080 (ландшафт),
// якщо вона ще не такого розміру. Використовує fit: "cover" — масштабує
// пропорційно і обрізає по центру щоб точно влізло в target.
export async function resizeStaticToAppLovinSpec(
  inputBuffer: ArrayBuffer
): Promise<ResizeResult> {
  const input = Buffer.from(inputBuffer);
  const meta = await sharp(input).metadata();
  const { width, height, format } = meta;

  if (!width || !height) {
    return { buffer: inputBuffer, resized: false };
  }

  const isPortrait = height >= width;
  const targetW = isPortrait ? TARGET_PORTRAIT_W : TARGET_LANDSCAPE_W;
  const targetH = isPortrait ? TARGET_PORTRAIT_H : TARGET_LANDSCAPE_H;

  if (width === targetW && height === targetH) {
    return { buffer: inputBuffer, resized: false, fromWidth: width, fromHeight: height };
  }

  const pipeline = sharp(input).resize(targetW, targetH, {
    fit: "cover",
    position: "center",
  });

  // Зберігаємо оригінальний формат якщо це JPG/PNG, інакше → PNG
  const out =
    format === "jpeg" || format === "jpg"
      ? await pipeline.jpeg({ quality: 90 }).toBuffer()
      : await pipeline.png().toBuffer();

  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    resized: true,
    fromWidth: width,
    fromHeight: height,
    toWidth: targetW,
    toHeight: targetH,
  };
}
