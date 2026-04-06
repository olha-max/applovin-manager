import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 text-white">
      <h1 className="mb-4 text-5xl font-bold">AppLovin Manager</h1>
      <p className="mb-8 text-lg text-slate-300">
        Управління кампаніями та креативами
      </p>
      <Link
        href="/login"
        className="rounded-lg bg-blue-600 px-8 py-3 text-lg font-medium transition hover:bg-blue-700"
      >
        Увійти
      </Link>
    </main>
  );
}
