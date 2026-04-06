"use client";

import { useState, useEffect, useCallback } from "react";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    name: "",
    role: "USER",
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadUsers = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    const data = await res.json();
    setUsers(data.users || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowForm(false);
      setFormData({ email: "", password: "", name: "", role: "USER" });
      loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Помилка");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(user: User) {
    await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: user.id, active: !user.active }),
    });
    loadUsers();
  }

  async function toggleRole(user: User) {
    const newRole = user.role === "ADMIN" ? "USER" : "ADMIN";
    await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: user.id, role: newRole }),
    });
    loadUsers();
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Користувачі</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          {showForm ? "Скасувати" : "Додати користувача"}
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
              <label className="mb-1 block text-sm text-slate-300">
                Ім&apos;я
              </label>
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
              <label className="mb-1 block text-sm text-slate-300">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-300">
                Пароль
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) =>
                  setFormData({ ...formData, password: e.target.value })
                }
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-300">Роль</label>
              <select
                value={formData.role}
                onChange={(e) =>
                  setFormData({ ...formData, role: e.target.value })
                }
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              >
                <option value="USER">Користувач</option>
                <option value="ADMIN">Адміністратор</option>
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
      ) : (
        <div className="overflow-hidden rounded-xl bg-slate-800">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="border-b border-slate-700 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-6 py-3">Ім&apos;я</th>
                <th className="px-6 py-3">Email</th>
                <th className="px-6 py-3">Роль</th>
                <th className="px-6 py-3">Статус</th>
                <th className="px-6 py-3">Дії</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-slate-700/50 hover:bg-slate-700/30"
                >
                  <td className="px-6 py-3 font-medium text-white">
                    {u.name}
                  </td>
                  <td className="px-6 py-3">{u.email}</td>
                  <td className="px-6 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        u.role === "ADMIN"
                          ? "bg-purple-500/20 text-purple-400"
                          : "bg-blue-500/20 text-blue-400"
                      }`}
                    >
                      {u.role === "ADMIN" ? "Адмін" : "Користувач"}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        u.active
                          ? "bg-green-500/20 text-green-400"
                          : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {u.active ? "Активний" : "Заблокований"}
                    </span>
                  </td>
                  <td className="flex gap-2 px-6 py-3">
                    <button
                      onClick={() => toggleRole(u)}
                      className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600"
                    >
                      Змінити роль
                    </button>
                    <button
                      onClick={() => toggleActive(u)}
                      className={`rounded px-2 py-1 text-xs ${
                        u.active
                          ? "bg-red-600/30 text-red-400 hover:bg-red-600/50"
                          : "bg-green-600/30 text-green-400 hover:bg-green-600/50"
                      }`}
                    >
                      {u.active ? "Заблокувати" : "Активувати"}
                    </button>
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
