import { NextRequest, NextResponse } from "next/server";
import { removeAuthCookie } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getAuthUser, getClientIp } from "@/lib/api-utils";

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);

  if (user) {
    await logAudit({
      userId: user.userId,
      action: "LOGOUT",
      entity: "session",
      entityId: user.sessionId,
      ip: getClientIp(req),
    });
  }

  await removeAuthCookie();
  return NextResponse.json({ ok: true });
}
