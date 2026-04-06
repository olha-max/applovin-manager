import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

interface AuditParams {
  userId: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export async function logAudit(params: AuditParams) {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      details: (params.details as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      ip: params.ip,
    },
  });
}
