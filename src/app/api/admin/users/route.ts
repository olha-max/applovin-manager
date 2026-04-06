import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createUserSchema, updateUserSchema } from "@/lib/validators";
import { logAudit } from "@/lib/audit";
import { getAuthUser, jsonError, getClientIp } from "@/lib/api-utils";

async function requireAdmin(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return null;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return jsonError("Доступ заборонено", 403);

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return jsonError("Доступ заборонено", 403);

  const body = await req.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0].message);
  }

  const existing = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });
  if (existing) return jsonError("Користувач з таким email вже існує");

  const hashedPassword = await bcrypt.hash(parsed.data.password, 12);
  const user = await prisma.user.create({
    data: {
      ...parsed.data,
      password: hashedPassword,
    },
    select: { id: true, email: true, name: true, role: true },
  });

  await logAudit({
    userId: admin.userId,
    action: "CREATE_USER",
    entity: "user",
    entityId: user.id,
    details: { email: user.email, role: user.role },
    ip: getClientIp(req),
  });

  return NextResponse.json({ user }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return jsonError("Доступ заборонено", 403);

  const body = await req.json();
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0].message);
  }

  const { id, ...data } = parsed.data;

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, active: true },
  });

  await logAudit({
    userId: admin.userId,
    action: "UPDATE_USER",
    entity: "user",
    entityId: user.id,
    details: data,
    ip: getClientIp(req),
  });

  return NextResponse.json({ user });
}
