import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createToken, setAuthCookie } from "@/lib/auth";
import { loginSchema } from "@/lib/validators";
import { logAudit } from "@/lib/audit";
import { jsonError, getClientIp } from "@/lib/api-utils";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0].message);
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) {
      return jsonError("Невірний email або пароль", 401);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return jsonError("Невірний email або пароль", 401);
    }

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const token = await createToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      sessionId: session.id,
    });

    await setAuthCookie(token);

    await logAudit({
      userId: user.id,
      action: "LOGIN",
      entity: "session",
      entityId: session.id,
      ip: getClientIp(req),
    });

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch {
    return jsonError("Внутрішня помилка сервера", 500);
  }
}
