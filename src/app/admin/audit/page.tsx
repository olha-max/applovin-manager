"use client";

import { useState, useEffect, useCallback } from "react";

interface AuditLog {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
  user: { email: string; name: string };
}

interface Pagination {
  page: number;
  pages: number;
  total: number;
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pages: 1,
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/audit?page=${page}&limit=20`);
    const data = await res.json();
    setLogs(data.logs || []);
    setPagination(data.pagination || { page: 1, pages: 1, total: 0 });
    setLoading(false);
  }, [page]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Журнал аудиту</h1>
        <span className="text-sm text-slate-400">
          Всього записів: {pagination.total}
        </span>
      </div>

      {loading ? (
        <div className="text-center text-slate-400">Завантаження...</div>
      ) : logs.length === 0 ? (
        <div className="rounded-xl bg-slate-800 p-12 text-center text-slate-400">
          Записи не знайдено
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl bg-slate-800">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-700 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-6 py-3">Час</th>
                  <th className="px-6 py-3">Користувач</th>
                  <th className="px-6 py-3">Дія</th>
                  <th className="px-6 py-3">Сутність</th>
                  <th className="px-6 py-3">IP</th>
                  <th className="px-6 py-3">Деталі</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="border-b border-slate-700/50 hover:bg-slate-700/30"
                  >
                    <td className="whitespace-nowrap px-6 py-3 text-xs">
                      {new Date(log.createdAt).toLocaleString("uk-UA")}
                    </td>
                    <td className="px-6 py-3">{log.user.email}</td>
                    <td className="px-6 py-3">
                      <span className="rounded bg-slate-700 px-2 py-0.5 text-xs font-mono">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      {log.entity}
                      {log.entityId && (
                        <span className="ml-1 text-xs text-slate-500">
                          #{log.entityId.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs text-slate-500">
                      {log.ip || "—"}
                    </td>
                    <td className="max-w-xs truncate px-6 py-3 text-xs text-slate-500">
                      {log.details ? JSON.stringify(log.details) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination.pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-300 disabled:opacity-50"
              >
                Попередня
              </button>
              <span className="text-sm text-slate-400">
                {page} / {pagination.pages}
              </span>
              <button
                onClick={() => setPage(Math.min(pagination.pages, page + 1))}
                disabled={page === pagination.pages}
                className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-300 disabled:opacity-50"
              >
                Наступна
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
