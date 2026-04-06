import { NextRequest, NextResponse } from "next/server";
import { verifyToken, JWTPayload } from "./auth";

export function jsonError(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function getAuthUser(
  req: NextRequest
): Promise<JWTPayload | null> {
  const token = req.cookies.get("auth-token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}
