"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";

interface NavbarProps {
  user: { name: string; email: string; role: string };
}

export default function Navbar({ user }: NavbarProps) {
  const router = useRouter();
  const pathname = usePathname();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const linkClass = (href: string) =>
    `px-3 py-2 rounded-lg text-sm font-medium transition ${
      pathname.startsWith(href)
        ? "bg-slate-700 text-white"
        : "text-slate-300 hover:text-white hover:bg-slate-700/50"
    }`;

  return (
    <nav className="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-6 py-3">
      <div className="flex items-center gap-6">
        <Link href="/dashboard" className="text-lg font-bold text-white">
          AppLovin Manager
        </Link>
        <div className="flex gap-1">
          <Link href="/dashboard" className={linkClass("/dashboard")}>
            Кампанії
          </Link>
          <Link
            href="/dashboard/creatives"
            className={linkClass("/dashboard/creatives")}
          >
            Креативи
          </Link>
          {user.role === "ADMIN" && (
            <>
              <Link href="/admin/users" className={linkClass("/admin/users")}>
                Користувачі
              </Link>
              <Link href="/admin/audit" className={linkClass("/admin/audit")}>
                Аудит
              </Link>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-slate-400">{user.name}</span>
        <button
          onClick={handleLogout}
          className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-600 hover:text-white"
        >
          Вийти
        </button>
      </div>
    </nav>
  );
}
