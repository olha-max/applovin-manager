import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Невірний формат email"),
  password: z.string().min(6, "Пароль мінімум 6 символів"),
});

export const createUserSchema = z.object({
  email: z.string().email("Невірний формат email"),
  password: z.string().min(6, "Пароль мінімум 6 символів"),
  name: z.string().min(1, "Ім'я обов'язкове"),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});

export const updateUserSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  active: z.boolean().optional(),
});

export const campaignCreateSchema = z.object({
  name: z.string().min(1, "Назва обов'язкова"),
  app_id: z.string().min(1, "App ID обов'язковий"),
  target_cpi: z.number().positive().optional(),
  daily_budget: z.number().positive().optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export const creativeCreateSchema = z.object({
  name: z.string().min(1, "Назва обов'язкова"),
  campaign_id: z.string().min(1, "Campaign ID обов'язковий"),
  creative_type: z.string().min(1, "Тип креативу обов'язковий"),
});

export const smartCreativeSchema = z.object({
  name: z.string().min(1, "Назва обов'язкова"),
  driveFolderUrl: z
    .string()
    .url("Невірний URL")
    .refine(
      (url) => url.includes("drive.google.com/drive/folders/"),
      "Посилання має бути на папку Google Drive"
    ),
  mode: z.enum(["upload", "create"]).optional(),
  // Для mode="create" — передаються з фази upload
  assetId: z.string().optional(),
  assetType: z.string().optional(),
  fileName: z.string().optional(),
});

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  action: z.string().optional(),
  userId: z.string().optional(),
});
