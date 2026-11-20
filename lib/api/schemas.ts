import { z } from "zod";
import { ITEM_KINDS } from "./util";

/** Zod schemas shared by the admin API routes. All request bodies are validated here. */

const transportSchema = z.enum(["http", "sse", "stdio"]);
const authTypeSchema = z.enum(["none", "headers", "bearer", "oauth"]);
const startModeSchema = z.enum(["always", "lazy"]);
const subjectTypeSchema = z.enum(["role", "key"]);
const toolModeSchema = z.enum(["all", "selected"]);
const scopeSchema = z.enum(["agent", "admin"]);
const exposureSchema = z.enum(["direct", "discovery"]);

const stringMap = z.record(z.string(), z.string());

/** Accepts epoch ms or an ISO string; yields epoch ms or null. */
export const dateInputSchema = z
  .union([z.number().int(), z.string()])
  .nullable()
  .transform((value, ctx): number | null => {
    if (value === null) return null;
    if (typeof value === "number") return value;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: "custom", message: "Invalid date: expected epoch ms or ISO 8601" });
      return z.NEVER;
    }
    return parsed;
  });

/** One subject entry of the create-upstream "Access" section (spec §7.4). */
export const accessSubjectSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().min(1),
  toolMode: toolModeSchema.default("all"),
  tools: z.array(z.string().min(1)).default([]),
  prompts: z.boolean().optional(),
  resources: z.boolean().optional(),
});

export const accessSectionSchema = z.object({
  subjects: z.array(accessSubjectSchema).default([]),
  /** Fallback flags applied to every subject that does not set its own. */
  prompts: z.boolean().optional(),
  resources: z.boolean().optional(),
});

const upstreamBase = {
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]{1,12}$/, "slug must be 1-12 chars of [a-z0-9]")
    .optional(),
  description: z.string().max(2000).nullish(),
  transport: transportSchema,
  url: z.string().url().nullish(),
  command: z.string().min(1).nullish(),
  args: z.array(z.string()).nullish(),
  cwd: z.string().min(1).nullish(),
  /** Plaintext secrets: encrypted before storage, never returned. */
  env: stringMap.nullish(),
  headers: stringMap.nullish(),
  /** Convenience for authType=bearer: stored as headers.Authorization. */
  /** Stored as headers.Authorization; null clears it on PATCH. */
  bearerToken: z.string().min(1).nullish(),
  oauth: z.record(z.string(), z.unknown()).nullish(),
  authType: authTypeSchema.default("none"),
  enabled: z.boolean().default(true),
  startMode: startModeSchema.default("always"),
  idleStopMinutes: z.number().int().min(0).max(10_080).default(15),
  callTimeoutSeconds: z.number().int().min(1).max(3600).default(120),
};

export const upstreamCreateSchema = z
  .object({
    ...upstreamBase,
    access: accessSectionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.transport === "stdio") {
      if (!value.command) ctx.addIssue({ code: "custom", path: ["command"], message: "command is required for stdio transport" });
      return;
    }
    if (!value.url) ctx.addIssue({ code: "custom", path: ["url"], message: "url is required for http/sse transport" });
  });

export type UpstreamCreateInput = z.infer<typeof upstreamCreateSchema>;

export const upstreamPatchSchema = z.object({
  name: upstreamBase.name.optional(),
  slug: upstreamBase.slug,
  description: upstreamBase.description,
  url: upstreamBase.url,
  command: upstreamBase.command,
  args: upstreamBase.args,
  cwd: upstreamBase.cwd,
  env: upstreamBase.env,
  headers: upstreamBase.headers,
  bearerToken: upstreamBase.bearerToken,
  oauth: upstreamBase.oauth,
  authType: authTypeSchema.optional(),
  enabled: z.boolean().optional(),
  startMode: startModeSchema.optional(),
  idleStopMinutes: z.number().int().min(0).max(10_080).optional(),
  callTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

export type UpstreamPatchInput = z.infer<typeof upstreamPatchSchema>;

export const overrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    alias: z.string().min(1).max(120).nullable().optional(),
    descriptionOverride: z.string().max(4000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one of enabled, alias, descriptionOverride is required" });

export const upstreamTestSchema = z.object({
  /** Test a stored upstream (using its encrypted secrets) instead of a candidate config. */
  id: z.string().min(1).optional(),
  transport: transportSchema.optional(),
  url: z.string().url().nullish(),
  command: z.string().min(1).nullish(),
  args: z.array(z.string()).nullish(),
  cwd: z.string().min(1).nullish(),
  env: stringMap.nullish(),
  headers: stringMap.nullish(),
  bearerToken: z.string().min(1).nullish(),
  authType: authTypeSchema.default("none"),
});

export const keyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  scope: scopeSchema.default("agent"),
  exposureMode: exposureSchema.default("direct"),
  expiresAt: dateInputSchema.optional(),
  roleIds: z.array(z.string().min(1)).default([]),
  /** "Copy the rights of this key…" (spec §7.1). */
  copyFromKeyId: z.string().min(1).optional(),
  /** Initial grants, applied after creation. */
  grants: z
    .array(
      z.object({
        upstreamId: z.string().min(1),
        toolMode: toolModeSchema.default("all"),
        tools: z.array(z.string().min(1)).default([]),
        prompts: z.boolean().default(false),
        resources: z.boolean().default(false),
      }),
    )
    .default([]),
});

export const keyPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullish(),
    exposureMode: exposureSchema.optional(),
    expiresAt: dateInputSchema.optional(),
    roleIds: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable field provided" });

export const rotateSchema = z.object({
  graceSeconds: z.number().int().min(0).max(7 * 24 * 3600).default(0),
});

export const duplicateSchema = z.object({ name: z.string().min(1).max(120) });

export const deniesSchema = z.object({
  denies: z
    .array(
      z.object({
        upstreamId: z.string().min(1),
        toolName: z.string().min(1).nullable(),
      }),
    )
    .default([]),
});

export const roleCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  keyIds: z.array(z.string().min(1)).default([]),
});

export const rolePatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullish(),
    keyIds: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable field provided" });

export const roleKeysSchema = z.object({ keyIds: z.array(z.string().min(1)).default([]) });

export const grantSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().min(1),
  upstreamId: z.string().min(1),
  toolMode: toolModeSchema.default("all"),
  tools: z.array(z.string().min(1)).default([]),
  prompts: z.boolean().default(false),
  resources: z.boolean().default(false),
});

export const loginSchema = z.object({ password: z.string().min(1) });

export const settingsPatchSchema = z
  .object({
    publicUrl: z.string().max(500).optional(),
    feedbackEnabled: z.boolean().optional(),
    appriseUrl: z.string().max(500).optional(),
    appriseEnabled: z.boolean().optional(),
    logRetentionDays: z.number().int().min(1).max(3650).optional(),
    logRetentionRows: z.number().int().min(1000).max(10_000_000).optional(),
    discoveryThreshold: z.number().int().min(1).max(10_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable field provided" });

export const itemKindSchema = z.enum(ITEM_KINDS);
