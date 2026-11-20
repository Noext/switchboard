import { z } from "zod";
import { badRequest, guardResponse, json, parseBody, requireAdmin } from "@/lib/api/guard";
import {
  ImportParseError,
  importServers,
  parseImport,
  previewImport,
  type ImportFormat,
  type ImportPreview,
} from "@/lib/import";

/**
 * POST /api/v1/import
 *
 * Two shapes, matching spec §8 "Import" and §9:
 *
 *   { payload: "<config text>", format?: "claude-code"|"claude-desktop"|"codex", preview: true }
 *     -> { preview }                      — parses and returns the secret-free server list
 *
 *   { selection: [{name, slug?, transport?, url?, command?, args?, env?, headers?, ...}], access? }
 *     -> { created, skipped, ... }         — creates the upstream rows
 *
 *   { payload, format?, preview: false, selection: [...] }
 *     -> parse + import in one shot (the UI's "aperçu puis importer" flow)
 *
 * `access` is the §7.4 "Accès" section applied to every created upstream.
 */
export const dynamic = "force-dynamic";

const formatSchema = z.enum(["claude-code", "claude-desktop", "codex"]).optional();

const selectionSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(64).optional(),
  transport: z.enum(["http", "sse", "stdio"]).optional(),
  url: z.string().nullish(),
  command: z.string().nullish(),
  args: z.array(z.string()).nullish(),
  cwd: z.string().nullish(),
  env: z.record(z.string(), z.string()).nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
  bearerTokenEnvVar: z.string().nullish(),
  authType: z.enum(["none", "headers", "bearer", "oauth"]).optional(),
  enabled: z.boolean().optional(),
});

const accessSchema = z
  .object({
    subjects: z
      .array(
        z.object({
          subjectType: z.enum(["role", "key"]),
          subjectId: z.string().min(1),
          toolMode: z.enum(["all", "selected"]).default("all"),
          tools: z.array(z.string()).default([]),
          prompts: z.boolean().optional(),
          resources: z.boolean().optional(),
        }),
      )
      .default([]),
    prompts: z.boolean().optional(),
    resources: z.boolean().optional(),
  })
  .optional();

const bodySchema = z.object({
  /** Raw config text (.mcp.json / ~/.claude.json / claude_desktop_config.json / config.toml). */
  payload: z.string().optional(),
  format: formatSchema,
  /** true (default) = preview only; false = import the given selection. */
  preview: z.boolean().optional(),
  selection: z.array(selectionSchema).optional(),
  access: accessSchema,
});

/**
 * Applies the §7.4 access section to every created upstream.
 *
 * Never throws: the upstreams are already persisted, so a failure here must surface as a warning
 * on an otherwise-successful import rather than a 500 that hides what was created.
 */
async function applyAccess(
  createdSlugs: string[],
  access: z.infer<typeof accessSchema>,
  actor: string,
): Promise<string[]> {
  if (!access || access.subjects.length === 0 || createdSlugs.length === 0) return [];
  try {
    const { applyAccessSection } = await import("@/lib/api/upstreams");
    const { getDb } = await import("@/lib/db");
    const { upstreams } = await import("@/lib/db/schema");
    const { inArray } = await import("drizzle-orm");
    const rows = getDb().select().from(upstreams).where(inArray(upstreams.slug, createdSlugs)).all();
    for (const row of rows) applyAccessSection(row.id, access, actor);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`The upstreams were created, but applying the access section failed: ${message}`];
  }
}

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);

  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // --- Import mode: a selection was provided (with or without the original payload). -----------
  const wantsImport = body.preview === false || (body.selection !== undefined && body.preview !== true);
  if (wantsImport) {
    if (!body.selection || body.selection.length === 0) {
      return badRequest("A non-empty \`selection\` is required to import");
    }
    const result = importServers(
      body.selection.map((entry) => ({
        name: entry.name,
        slug: entry.slug,
        transport: entry.transport,
        url: entry.url ?? null,
        command: entry.command ?? null,
        args: entry.args ?? null,
        cwd: entry.cwd ?? null,
        env: entry.env ?? {},
        headers: entry.headers ?? {},
        bearerTokenEnvVar: entry.bearerTokenEnvVar ?? null,
        authType: entry.authType,
        enabled: entry.enabled,
      })),
      guard.actor,
    );
    const accessWarnings = await applyAccess(result.createdSlugs, body.access, guard.actor);
    return json({ mode: "import", ...result, warnings: [...result.warnings, ...accessWarnings] });
  }

  // --- Preview mode (default): parse the payload, never write anything. ------------------------
  if (!body.payload || body.payload.trim() === "") {
    return badRequest("\`payload\` (the config text) is required, or a \`selection\` to import");
  }

  let preview: ImportPreview;
  try {
    preview = previewImport(body.payload, body.format as ImportFormat | undefined);
  } catch (error) {
    if (error instanceof ImportParseError) {
      return badRequest(error.message, { format: error.format });
    }
    return badRequest(error instanceof Error ? error.message : "Could not parse the config");
  }

  // Allow a dry-run parse of a payload whose format the caller forced.
  if (body.format) {
    try {
      parseImport(body.payload, body.format);
    } catch {
      /* previewImport already validated it; ignore */
    }
  }

  return json({ mode: "preview", preview });
}
