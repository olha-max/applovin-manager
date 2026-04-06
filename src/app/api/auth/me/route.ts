import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, jsonError } from "@/lib/api-utils";

export async function GET(req: NextRequest) {
  const payload = await getAuthUser(req);
  if (!payload) return jsonError("Не авторизовано", 401);

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, name: true, role: true, active: true },
  });

  if (!user || !user.active) return jsonError("Не авторизовано", 401);

  return NextResponse.json({ user });
}
