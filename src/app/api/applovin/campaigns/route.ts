import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, createCampaign } from "@/lib/applovin";
import { campaignCreateSchema } from "@/lib/validators";
import { logAudit } from "@/lib/audit";
import { getAuthUser, jsonError, getClientIp } from "@/lib/api-utils";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return jsonError("Не авторизовано", 401);

  try {
    const data = await listCampaigns();

    await logAudit({
      userId: user.userId,
      action: "LIST_CAMPAIGNS",
      entity: "campaign",
      ip: getClientIp(req),
    });

    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Помилка API";
    return jsonError(message, 502);
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return jsonError("Не авторизовано", 401);

  try {
    const body = await req.json();
    const parsed = campaignCreateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0].message);
    }

    const data = await createCampaign(parsed.data);

    await logAudit({
      userId: user.userId,
      action: "CREATE_CAMPAIGN",
      entity: "campaign",
      details: parsed.data,
      ip: getClientIp(req),
    });

    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Помилка API";
    return jsonError(message, 502);
  }
}
