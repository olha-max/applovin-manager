import "server-only";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface TrimResult {
  buffer: ArrayBuffer;
  trimmed: boolean;
  fromDurationSec?: number;
  toDurationSec?: number;
}

// Обрізає відео з кінця: лишає перші maxSeconds секунд.
// Використовує stream copy (без re-encode) — швидко, без втрати якості.
// Через копіювання може округлитись до найближчого keyframe (тому ставимо
// бюджет 59с замість 59.9 щоб точно бути <60).
export async function trimVideoToMaxDuration(
  inputBuffer: ArrayBuffer,
  fromDurationSec: number,
  maxSeconds: number = 59
): Promise<TrimResult> {
  if (fromDurationSec <= maxSeconds + 0.5) {
    return { buffer: inputBuffer, trimmed: false, fromDurationSec };
  }

  if (!ffmpegPath) {
    throw new Error("ffmpeg-static binary не знайдено");
  }

  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const inputPath = join(tmpdir(), `in-${id}.mp4`);
  const outputPath = join(tmpdir(), `out-${id}.mp4`);

  try {
    await writeFile(inputPath, Buffer.from(inputBuffer));

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        "-i", inputPath,
        "-t", String(maxSeconds),
        "-c", "copy",
        "-movflags", "+faststart",
        "-y",
        outputPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += String(d); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });
    });

    const out = await readFile(outputPath);
    return {
      buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
      trimmed: true,
      fromDurationSec,
      toDurationSec: maxSeconds,
    };
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}
