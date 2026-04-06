import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, jsonError } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return jsonError("Не авторизовано", 401);

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status");
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || "50")));

  const where: Record<string, unknown> = {};
  if (statusFilter === "ERROR" || statusFilter === "SUCCESS") {
    where.status = statusFilter;
  }

  const [logs, total] = await Promise.all([
    prisma.smartCreativeLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.smartCreativeLog.count({ where }),
  ]);

  return NextResponse.json({
    logs,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
}
