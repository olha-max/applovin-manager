"use client";

import { useState, useEffect, useCallback } from "react";

interface Campaign {
  id?: string;
  name?: string;
  app_id?: string;
  status?: string;
  daily_budget?: number;
  [key: string]: unknown;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    app_id: "",
    daily_budget: "",
    status: "active",
  });
  const [submitting, setSubmitting] = useState(false);

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await fetch("/api/applovin/campaigns");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCampaigns(Array.isArray(data) ? data : data.campaigns || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Помилка завантаження");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/applovin/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          daily_budget: formData.daily_budget
            ? Number(formData.daily_budget)
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowForm(false);
      setFormData({ name: "", app_id: "", daily_budget: "", status: "active" });
      loadCampaigns();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Помилка створення");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Кампанії</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          {showForm ? "Скасувати" : "Створити кампанію"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-6 rounded-xl bg-slate-800 p-6"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-slate-300">Назва</label>
              <input
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-300">
                App ID
              </label>
              <input
                value={formData.app_id}
                onChange={(e) =>
                  setFormData({ ...formData, app_id: e.target.value })
                }
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-300">
                Денний бюджет
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.daily_budget}
                onChange={(e) =>
                  setFormData({ ...formData, daily_budget: e.target.value })
                }
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-300">
                Статус
              </label>
              <select
                value={formData.status}
                onChange={(e) =>
                  setFormData({ ...formData, status: e.target.value })
                }
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              >
                <option value="active">Активна</option>
                <option value="paused">Призупинена</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="mt-4 rounded-lg bg-green-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? "Створення..." : "Створити"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-center text-slate-400">Завантаження...</div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl bg-slate-800 p-12 text-center text-slate-400">
          Кампанії не знайдено
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-slate-800">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="border-b border-slate-700 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-6 py-3">Назва</th>
                <th className="px-6 py-3">App ID</th>
                <th className="px-6 py-3">Статус</th>
                <th className="px-6 py-3">Бюджет</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c, i) => (
                <tr
                  key={c.id || i}
                  className="border-b border-slate-700/50 hover:bg-slate-700/30"
                >
                  <td className="px-6 py-3 font-medium text-white">
                    {c.name || "—"}
                  </td>
                  <td className="px-6 py-3">{c.app_id || "—"}</td>
                  <td className="px-6 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        c.status === "active"
                          ? "bg-green-500/20 text-green-400"
                          : "bg-yellow-500/20 text-yellow-400"
                      }`}
                    >
                      {c.status === "active" ? "Активна" : "Призупинена"}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                    {c.daily_budget ? `$${c.daily_budget}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
