"use client";

import { useState, useEffect, useCallback } from "react";

interface Creative {
  id?: string;
  name?: string;
  campaign_id?: string;
  creative_type?: string;
  [key: string]: unknown;
}

interface PipelineStep {
  step: string;
  label: string;
  status: "pending" | "progress" | "done" | "error";
  data?: Record<string, unknown>;
}

interface CreativeJob {
  name: string;
  driveFolderUrl: string;
  status: "pending" | "uploading" | "uploaded" | "creating" | "done" | "error";
  pipeline: PipelineStep[];
  error?: string;
  // Дані з фази upload для фази create
  uploadResult?: {
    assetId: string;
    assetType: string;
    fileName: string;
  };
  assetStatus?: string; // ACTIVE, REJECTED, PENDING_REVIEW, etc.
}

interface LogEntry {
  id: string;
  name: string;
  driveFolderUrl: string;
  fileName: string | null;
  assetType: string | null;
  angle: string | null;
  status: "SUCCESS" | "ERROR";
  error: string | null;
  campaignsCount: number;
  createdCount: number;
  createdAt: string;
  user: { name: string; email: string };
}

const UPLOAD_STEPS: Omit<PipelineStep, "status">[] = [
  { step: "parse_url", label: "Розбір посилання" },
  { step: "search_drive", label: "Пошук на Drive" },
  { step: "download", label: "Завантаження" },
  { step: "upload", label: "Upload в AppLovin" },
];

const CREATE_STEPS: Omit<PipelineStep, "status">[] = [
  { step: "approval_check", label: "Апрув" },
  { step: "extract_angle", label: "Angle" },
  { step: "report", label: "Топ ассети" },
  { step: "find_campaigns", label: "Кампанії" },
  { step: "create_sets", label: "Креативні сети" },
  { step: "complete", label: "Готово" },
];

function parseInput(text: string): { name: string; driveFolderUrl: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\t+/);
      if (parts.length >= 2) {
        return { name: parts[0].trim(), driveFolderUrl: parts[parts.length - 1].trim() };
      }
      const urlMatch = line.match(/^(.+?)\s+(https:\/\/.+)$/);
      if (urlMatch) {
        return { name: urlMatch[1].trim(), driveFolderUrl: urlMatch[2].trim() };
      }
      return null;
    })
    .filter((x): x is { name: string; driveFolderUrl: string } => x !== null);
}

async function processSSE(
  res: Response,
  onEvent: (event: { step: string; status: string; data?: Record<string, unknown> }) => void
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processLine(line: string) {
    if (!line.startsWith("data: ")) return;
    try {
      onEvent(JSON.parse(line.slice(6)));
    } catch {
      // skip
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      processLine(line);
    }
  }

  // Flush залишок буфера (остання подія може не мати trailing newline)
  if (buffer.trim()) {
    processLine(buffer.trim());
  }
}

export default function CreativesPage() {
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [bulkInput, setBulkInput] = useState("");
  const [jobs, setJobs] = useState<CreativeJob[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "uploaded" | "creating">("idle");
  const [showForm, setShowForm] = useState(false);

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsFilter, setLogsFilter] = useState<"" | "ERROR" | "SUCCESS">("");
  const [showLogs, setShowLogs] = useState(false);

  const loadCreatives = useCallback(async () => {
    try {
      const res = await fetch("/api/applovin/creatives");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCreatives(
        Array.isArray(data) ? data : data.creative_sets || data.creatives || []
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Помилка завантаження");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (logsFilter) params.set("status", logsFilter);
      const res = await fetch(`/api/applovin/smart-creative-logs?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLogs(data.logs || []);
    } catch {
      // silent
    } finally {
      setLogsLoading(false);
    }
  }, [logsFilter]);

  useEffect(() => {
    loadCreatives();
  }, [loadCreatives]);

  useEffect(() => {
    if (showLogs) loadLogs();
  }, [showLogs, loadLogs]);

  // Polling статусів ассетів кожну хвилину (коли Phase 1 завершена)
  useEffect(() => {
    if (phase !== "uploaded") return;

    async function pollStatuses() {
      // Зібрати всі assetId з pipeline step data
      const assetIds: string[] = [];
      const jobAssetMap: Map<number, string> = new Map();

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.status === "error") continue;
        for (const step of job.pipeline) {
          if (step.data?.assetId) {
            const id = String(step.data.assetId);
            assetIds.push(id);
            jobAssetMap.set(i, id);
            break;
          }
        }
      }

      if (assetIds.length === 0) return;

      try {
        const res = await fetch(`/api/applovin/asset-status?ids=${assetIds.join(",")}`);
        if (!res.ok) return;
        const { statuses } = await res.json() as { statuses: Record<string, string> };

        setJobs((prev) =>
          prev.map((j, i) => {
            const assetId = jobAssetMap.get(i);
            if (!assetId || !statuses[assetId]) return j;
            return { ...j, assetStatus: statuses[assetId] };
          })
        );
      } catch {
        // silent
      }
    }

    // Перший запит одразу
    pollStatuses();
    // Потім кожну хвилину
    const interval = setInterval(pollStatuses, 60_000);
    return () => clearInterval(interval);
  }, [phase, jobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ========== Phase 1: Upload ==========
  async function uploadJob(
    job: { name: string; driveFolderUrl: string },
    jobIndex: number
  ): Promise<{ assetId: string; assetType: string; fileName: string } | null> {
    const initPipeline = UPLOAD_STEPS.map((s) => ({ ...s, status: "pending" as const }));

    setJobs((prev) =>
      prev.map((j, i) =>
        i === jobIndex ? { ...j, status: "uploading", pipeline: initPipeline } : j
      )
    );

    let uploadResult: { assetId: string; assetType: string; fileName: string } | null = null;
    let lastError = "";

    try {
      const res = await fetch("/api/applovin/smart-creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...job, mode: "upload" }),
      });

      if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await res.json();
        throw new Error(data.error || "Помилка запиту");
      }

      // Збираємо дані з різних подій як fallback
      let collectedAssetId = "";
      let collectedAssetType = "";
      let collectedFileName = "";
      let collectedAssetStatus = "";

      await processSSE(res, (event) => {
        setJobs((prev) =>
          prev.map((j, i) =>
            i === jobIndex
              ? {
                  ...j,
                  pipeline: j.pipeline.map((s) =>
                    s.step === event.step
                      ? { ...s, status: event.status as PipelineStep["status"], data: event.data }
                      : s
                  ),
                }
              : j
          )
        );

        // Основний спосіб: подія upload_done
        if (event.step === "upload_done" && event.status === "done" && event.data) {
          uploadResult = {
            assetId: event.data.assetId as string,
            assetType: event.data.assetType as string,
            fileName: event.data.fileName as string,
          };
        }

        // Fallback: збираємо дані з окремих подій
        if (event.data?.assetId && event.status === "done") {
          collectedAssetId = String(event.data.assetId);
        }
        if (event.data?.assetType && event.status === "done") {
          collectedAssetType = String(event.data.assetType);
        }
        if (event.data?.fileName && event.status === "done") {
          collectedFileName = String(event.data.fileName);
        }
        if (event.data?.assetStatus && event.status === "done") {
          collectedAssetStatus = String(event.data.assetStatus);
        }

        if (event.status === "error" && event.data?.message) {
          lastError = String(event.data.message);
        }
      });

      // Fallback: якщо upload_done не спрацював, зібрати з окремих подій
      if (!uploadResult && collectedAssetId && !lastError) {
        // Нормалізуємо assetType (AppLovin повертає "VIDEO"/"IMAGE" в uppercase)
        const normalized = collectedAssetType.toLowerCase();
        const resolvedType = normalized.includes("vid") ? "video"
          : normalized.includes("html") || normalized.includes("hosted") ? "html"
          : "image";
        uploadResult = {
          assetId: collectedAssetId,
          assetType: resolvedType,
          fileName: collectedFileName || job.name,
        };
      }

      const finalAssetStatus = collectedAssetStatus || "UNKNOWN";

      setJobs((prev) =>
        prev.map((j, i) =>
          i === jobIndex
            ? {
                ...j,
                status: lastError ? "error" : "uploaded",
                error: lastError || undefined,
                uploadResult: uploadResult || undefined,
                assetStatus: finalAssetStatus,
              }
            : j
        )
      );

      return uploadResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Помилка";
      setJobs((prev) =>
        prev.map((j, i) =>
          i === jobIndex ? { ...j, status: "error", error: msg } : j
        )
      );
      return null;
    }
  }

  // ========== Phase 2: Create Creative Sets ==========
  async function createJob(
    job: CreativeJob,
    jobIndex: number
  ) {
    if (!job.uploadResult) return;

    const createPipeline = CREATE_STEPS.map((s) => ({ ...s, status: "pending" as const }));

    setJobs((prev) =>
      prev.map((j, i) =>
        i === jobIndex
          ? { ...j, status: "creating", pipeline: [...j.pipeline, ...createPipeline] }
          : j
      )
    );

    let lastError = "";

    try {
      const res = await fetch("/api/applovin/smart-creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: job.name,
          driveFolderUrl: job.driveFolderUrl,
          mode: "create",
          assetId: job.uploadResult.assetId,
          assetType: job.uploadResult.assetType,
          fileName: job.uploadResult.fileName,
        }),
      });

      if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await res.json();
        throw new Error(data.error || "Помилка запиту");
      }

      await processSSE(res, (event) => {
        setJobs((prev) =>
          prev.map((j, i) =>
            i === jobIndex
              ? {
                  ...j,
                  pipeline: j.pipeline.map((s) =>
                    s.step === event.step
                      ? { ...s, status: event.status as PipelineStep["status"], data: event.data }
                      : s
                  ),
                }
              : j
          )
        );

        if (event.status === "error" && event.data?.message) {
          lastError = String(event.data.message);
        }
        if (event.data?.errorDetail) {
          lastError = lastError
            ? `${lastError}\n${event.data.errorDetail}`
            : String(event.data.errorDetail);
        }
      });

      setJobs((prev) =>
        prev.map((j, i) =>
          i === jobIndex
            ? {
                ...j,
                status: lastError ? "error" : "done",
                error: lastError || undefined,
              }
            : j
        )
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Помилка";
      setJobs((prev) =>
        prev.map((j, i) =>
          i === jobIndex ? { ...j, status: "error", error: msg } : j
        )
      );
    }
  }

  // ========== Batch Handler ==========
  async function handleBulkCreate(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseInput(bulkInput);
    if (parsed.length === 0) {
      setError("Не вдалося розпарсити рядки. Формат: назва<TAB>посилання");
      return;
    }

    setError("");
    setRunning(true);

    const initialJobs: CreativeJob[] = parsed.map((p) => ({
      ...p,
      status: "pending",
      pipeline: [],
    }));
    setJobs(initialJobs);

    // Phase 1: Upload all (з паузою між job щоб не дросселити Google Drive API)
    setPhase("uploading");
    const uploadResults: Array<{ assetId: string; assetType: string; fileName: string } | null> = [];
    for (let i = 0; i < parsed.length; i++) {
      // Пауза 5с між job для уникнення Google Drive rate limit
      if (i > 0) await new Promise((r) => setTimeout(r, 5000));
      const result = await uploadJob(parsed[i], i);
      uploadResults.push(result);
    }

    // Phase 1 завершена — Phase 2 запускається кнопкою
    setPhase("uploaded");
    setRunning(false);
  }

  // ========== Phase 2: Manual trigger ==========
  function extractUploadData(job: CreativeJob): { assetId: string; assetType: string; fileName: string; assetStatus: string } | null {
    // Зчитуємо з pipeline step data (найнадійніший спосіб)
    let assetId = "";
    let assetType = "";
    let fileName = "";
    let assetStatus = job.assetStatus || "";

    // Якщо вже є uploadResult — беремо як базу
    if (job.uploadResult) {
      assetId = job.uploadResult.assetId;
      assetType = job.uploadResult.assetType;
      fileName = job.uploadResult.fileName;
    }

    // Доповнюємо з pipeline step data
    for (const step of job.pipeline) {
      if (step.status !== "done" || !step.data) continue;
      if (step.data.assetId) assetId = String(step.data.assetId);
      if (step.data.assetType && !assetType) assetType = String(step.data.assetType);
      if (step.data.fileName) fileName = String(step.data.fileName);
      if (step.data.assetStatus) assetStatus = String(step.data.assetStatus);
    }

    if (!assetId) return null;

    // Нормалізуємо assetType
    const normalized = assetType.toLowerCase();
    const resolvedType = normalized.includes("vid") ? "video"
      : normalized.includes("html") || normalized.includes("hosted") ? "html"
      : "image";

    return { assetId, assetType: resolvedType, fileName: fileName || job.name, assetStatus };
  }

  async function startPhase2() {
    setRunning(true);
    setPhase("creating");

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (job.status === "error") continue;

      const uploadData = extractUploadData(job);
      if (!uploadData) {
        setJobs((prev) =>
          prev.map((j, idx) =>
            idx === i ? { ...j, status: "error", error: "Не вдалося отримати assetId з pipeline" } : j
          )
        );
        continue;
      }

      // Пропустити REJECTED ассети
      if (uploadData.assetStatus.toUpperCase() === "REJECTED") {
        setJobs((prev) =>
          prev.map((j, idx) =>
            idx === i ? { ...j, status: "error", error: `Asset rejected AppLovin (status: ${uploadData.assetStatus})` } : j
          )
        );
        continue;
      }

      if (i > 0) await new Promise((r) => setTimeout(r, 1000));
      await createJob({ ...job, uploadResult: uploadData }, i);
    }

    setPhase("idle");
    setRunning(false);
    loadCreatives();
    if (showLogs) loadLogs();
  }

  function retryFailed() {
    const failedLogs = logs.filter((l) => l.status === "ERROR");
    if (failedLogs.length === 0) return;

    const retryText = failedLogs
      .map((l) => `${l.name}\t${l.driveFolderUrl}`)
      .join("\n");

    setBulkInput(retryText);
    setShowForm(true);
    setShowLogs(false);
  }

  function retrySingleLog(log: LogEntry) {
    setBulkInput(`${log.name}\t${log.driveFolderUrl}`);
    setShowForm(true);
    setShowLogs(false);
  }

  function getStepIcon(status: PipelineStep["status"]) {
    switch (status) {
      case "pending":
        return (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[10px] text-slate-500">
            -
          </span>
        );
      case "progress":
        return (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] text-white animate-pulse">
            ...
          </span>
        );
      case "done":
        return (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-600 text-[10px] text-white">
            &#10003;
          </span>
        );
      case "error":
        return (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] text-white">
            &#10007;
          </span>
        );
    }
  }

  function getJobStatusBadge(job: CreativeJob) {
    switch (job.status) {
      case "pending":
        return (
          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-400">
            В черзі
          </span>
        );
      case "uploading":
        return (
          <span className="rounded bg-blue-600/20 px-2 py-0.5 text-xs text-blue-300 animate-pulse">
            Завантаження...
          </span>
        );
      case "uploaded":
        return (
          <span className="rounded bg-yellow-600/20 px-2 py-0.5 text-xs text-yellow-300">
            Завантажено
          </span>
        );
      case "creating":
        return (
          <span className="rounded bg-purple-600/20 px-2 py-0.5 text-xs text-purple-300 animate-pulse">
            Створення сетів...
          </span>
        );
      case "done":
        return (
          <span className="rounded bg-green-600/20 px-2 py-0.5 text-xs text-green-300">
            Готово
          </span>
        );
      case "error":
        return (
          <span className="rounded bg-red-600/20 px-2 py-0.5 text-xs text-red-300">
            Помилка
          </span>
        );
    }
  }

  const parsedPreview = bulkInput ? parseInput(bulkInput) : [];
  const failedLogsCount = logs.filter((l) => l.status === "ERROR").length;

  const uploadedCount = jobs.filter((j) => ["uploaded", "creating", "done"].includes(j.status)).length;
  const createdCount = jobs.filter((j) => j.status === "done").length;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Креативи</h1>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setShowLogs(!showLogs);
              if (showForm) setShowForm(false);
            }}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-600"
          >
            {showLogs ? "Сховати логи" : "Логи"}
          </button>
          <button
            onClick={() => {
              setShowForm(!showForm);
              if (showLogs) setShowLogs(false);
              setJobs([]);
              setError("");
              setPhase("idle");
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            {showForm ? "Скасувати" : "Smart Creative"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {showLogs && (
        <div className="mb-6 rounded-xl bg-slate-800 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">
              Логи Smart Creative
            </h2>
            <div className="flex gap-2">
              {failedLogsCount > 0 && (
                <button
                  onClick={retryFailed}
                  className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-orange-700"
                >
                  Retry всіх помилок ({failedLogsCount})
                </button>
              )}
              <select
                value={logsFilter}
                onChange={(e) =>
                  setLogsFilter(e.target.value as "" | "ERROR" | "SUCCESS")
                }
                className="rounded-lg border border-slate-600 bg-slate-700 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                <option value="">Всі</option>
                <option value="ERROR">Помилки</option>
                <option value="SUCCESS">Успішні</option>
              </select>
              <button
                onClick={loadLogs}
                className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-600"
              >
                Оновити
              </button>
            </div>
          </div>

          {logsLoading ? (
            <div className="text-center text-sm text-slate-400">
              Завантаження...
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center text-sm text-slate-500">
              Логів немає
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className={`flex items-start justify-between rounded-lg border p-3 ${
                    log.status === "ERROR"
                      ? "border-red-600/30 bg-red-900/10"
                      : "border-green-600/30 bg-green-900/10"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          log.status === "ERROR"
                            ? "bg-red-600/30 text-red-300"
                            : "bg-green-600/30 text-green-300"
                        }`}
                      >
                        {log.status}
                      </span>
                      <span className="truncate text-sm font-medium text-white">
                        {log.name}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-400">
                      <span>
                        {new Date(log.createdAt).toLocaleString("uk-UA")}
                      </span>
                      {log.fileName && <span>Файл: {log.fileName}</span>}
                      {log.angle && <span>Angle: _{log.angle}_</span>}
                      {log.assetType && <span>Тип: {log.assetType}</span>}
                      {log.campaignsCount > 0 && (
                        <span>
                          Кампаній: {log.campaignsCount}, створено:{" "}
                          {log.createdCount}
                        </span>
                      )}
                    </div>
                    {log.error && (
                      <p className="mt-1 text-xs text-red-400">{log.error}</p>
                    )}
                  </div>
                  {log.status === "ERROR" && (
                    <button
                      onClick={() => retrySingleLog(log)}
                      className="ml-3 shrink-0 rounded bg-orange-600/20 px-2 py-1 text-xs text-orange-300 transition hover:bg-orange-600/40"
                    >
                      Retry
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showForm && (
        <div className="mb-6 rounded-xl bg-slate-800 p-6">
          <form onSubmit={handleBulkCreate}>
            <div>
              <label className="mb-1 block text-sm text-slate-300">
                Вставте креативи (по одному на рядок)
              </label>
              <textarea
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                placeholder={
                  "MCS-1510_static_ss_ad_v1\thttps://drive.google.com/drive/folders/...\nMCS-1511_static_ss_ad_v2\thttps://drive.google.com/drive/folders/..."
                }
                rows={6}
                required
                disabled={running}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-slate-500">
                Формат: назва&lt;TAB&gt;посилання_на_папку_Drive (кожен рядок =
                окремий креатив)
              </p>
            </div>

            {parsedPreview.length > 0 && !running && (
              <div className="mt-3 rounded-lg bg-slate-900/50 p-3">
                <p className="mb-2 text-xs text-slate-400">
                  Розпізнано {parsedPreview.length} креативів:
                </p>
                <div className="space-y-1">
                  {parsedPreview.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-slate-200 truncate max-w-[400px]">
                        {p.name}
                      </span>
                      <span className="text-slate-600">&rarr;</span>
                      <span className="text-slate-400 truncate max-w-[300px]">
                        {p.driveFolderUrl}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <button
                type="submit"
                disabled={running || parsedPreview.length === 0 || phase === "uploaded"}
                className="rounded-lg bg-green-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
              >
                {running && phase === "uploading"
                  ? `Завантаження (${uploadedCount}/${jobs.length})...`
                  : running && phase === "creating"
                    ? `Створення сетів (${createdCount}/${uploadedCount})...`
                    : `Завантажити (${parsedPreview.length})`}
              </button>

              {phase === "uploaded" && !running && uploadedCount > 0 && (
                <button
                  type="button"
                  onClick={startPhase2}
                  className="rounded-lg bg-purple-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-purple-700 animate-pulse"
                >
                  Створити сети ({uploadedCount})
                </button>
              )}
            </div>
          </form>

          {jobs.length > 0 && (
            <div className="mt-6">
              {/* Phase indicator */}
              {(running || phase === "uploaded") && (
                <div className="mb-4 flex items-center gap-3">
                  <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium ${
                    phase === "uploading"
                      ? "bg-blue-600/20 text-blue-300"
                      : phase === "uploaded"
                        ? "bg-yellow-600/20 text-yellow-300"
                        : "bg-green-600/20 text-green-300"
                  }`}>
                    <span className={phase === "uploading" || phase === "creating" ? "animate-pulse" : ""}>
                      {phase === "uploading" ? "Фаза 1: Завантаження всіх ассетів" : ""}
                      {phase === "uploaded" ? "Фаза 1 завершена. Натисніть \"Створити сети\" для запуску Фази 2" : ""}
                      {phase === "creating" ? "Фаза 2: Створення креативних сетів" : ""}
                    </span>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {jobs.map((job, i) => (
                  <div
                    key={i}
                    className={`rounded-lg border p-3 ${
                      job.status === "uploading" || job.status === "creating"
                        ? "border-blue-600/30 bg-blue-900/10"
                        : job.status === "error"
                          ? "border-red-600/30 bg-red-900/10"
                          : job.status === "done"
                            ? "border-green-600/30 bg-green-900/10"
                            : job.status === "uploaded"
                              ? "border-yellow-600/30 bg-yellow-900/10"
                              : "border-slate-700 bg-slate-900/30"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-white truncate max-w-[500px]">
                        {job.name}
                      </span>
                      <div className="flex items-center gap-2">
                        {job.assetStatus && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            job.assetStatus === "ACTIVE" ? "bg-green-600/30 text-green-300" :
                            job.assetStatus === "REJECTED" ? "bg-red-600/30 text-red-300" :
                            "bg-yellow-600/30 text-yellow-300"
                          }`}>
                            {job.assetStatus}
                          </span>
                        )}
                        {getJobStatusBadge(job)}
                      </div>
                    </div>

                    {job.pipeline.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {job.pipeline.map((step, si) => (
                          <div key={`${step.step}-${si}`}>
                            {/* Розділювач між upload та create фазами */}
                            {si > 0 &&
                              UPLOAD_STEPS.some((s) => s.step === job.pipeline[si - 1]?.step) &&
                              CREATE_STEPS.some((s) => s.step === step.step) && (
                                <span className="mr-2 text-slate-600">|</span>
                              )}
                            <span
                              className="inline-flex items-center gap-1"
                              title={
                                step.data
                                  ? Object.entries(step.data)
                                      .map(([k, v]) => `${k}: ${v}`)
                                      .join(", ")
                                  : step.label
                              }
                            >
                              {getStepIcon(step.status)}
                              <span className="text-[11px] text-slate-500">
                                {step.label}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {job.error && (
                      <p className="mt-2 text-xs text-red-400 whitespace-pre-wrap">{job.error}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center text-slate-400">Завантаження...</div>
      ) : creatives.length === 0 ? (
        <div className="rounded-xl bg-slate-800 p-12 text-center text-slate-400">
          Креативи не знайдено
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-slate-800">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="border-b border-slate-700 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-6 py-3">Назва</th>
                <th className="px-6 py-3">Campaign ID</th>
                <th className="px-6 py-3">Тип</th>
              </tr>
            </thead>
            <tbody>
              {creatives.map((c, i) => (
                <tr
                  key={c.id || i}
                  className="border-b border-slate-700/50 hover:bg-slate-700/30"
                >
                  <td className="px-6 py-3 font-medium text-white">
                    {c.name || "\u2014"}
                  </td>
                  <td className="px-6 py-3">{c.campaign_id || "\u2014"}</td>
                  <td className="px-6 py-3">{c.creative_type || "\u2014"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
