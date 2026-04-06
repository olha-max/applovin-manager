import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auditQuerySchema } from "@/lib/validators";
import { getAuthUser, jsonError } from "@/lib/api-utils";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user || user.role !== "ADMIN") {
    return jsonError("Доступ заборонено", 403);
  }

  const searchParams = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = auditQuerySchema.safeParse(searchParams);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0].message);
  }

  const { page, limit, action, userId } = parsed.data;
  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (userId) where.userId = userId;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return NextResponse.json({
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}
