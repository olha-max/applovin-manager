import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, jsonError } from "@/lib/api-utils";
import { listAssets } from "@/lib/applovin";

// GET /api/applovin/asset-status?ids=id1,id2,id3
// Повертає статуси ассетів по їх ID
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return jsonError("Не авторизовано", 401);

  const ids = req.nextUrl.searchParams.get("ids");
  if (!ids) return jsonError("ids parameter is required");

  const idList = ids.split(",").map((s) => s.trim()).filter(Boolean);
  if (idList.length === 0) return jsonError("No valid IDs provided");

  try {
    const assets = await listAssets();
    const idSet = new Set(idList);

    const statuses: Record<string, string> = {};
    for (const asset of assets) {
      if (idSet.has(asset.id)) {
        statuses[asset.id] = asset.status || "UNKNOWN";
      }
    }

    // Для ID які не знайшли — повертаємо UNKNOWN
    for (const id of idList) {
      if (!statuses[id]) {
        statuses[id] = "UNKNOWN";
      }
    }

    return NextResponse.json({ statuses });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Помилка";
    return jsonError(msg, 500);
  }
}
