/**
 * The global `report_feedback` tool (spec §6.5).
 *
 * It is added to the tool list of every agent key regardless of upstream access (so it shows up
 * even for a key with zero permissions, and in discovery mode), unless the admin disabled it in
 * Settings. It belongs to no upstream, so it always works — even when every upstream is down.
 *
 * All persistence lives in lib/feedback.ts (owned by the import/feedback module); this file only
 * adapts it to the MCP surface and can be loaded lazily so a not-yet-built feedback module never
 * breaks the gateway.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  REPORT_FEEDBACK_TOOL_DESCRIPTION,
  REPORT_FEEDBACK_TOOL_NAME,
} from "../feedback";
import { getSettings } from "../settings";

export const REPORT_FEEDBACK_NAME = REPORT_FEEDBACK_TOOL_NAME;

/** Agent-facing description, single-sourced from lib/feedback.ts (spec §6.5 verbatim). */
const DESCRIPTION = REPORT_FEEDBACK_TOOL_DESCRIPTION;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    category: {
      type: "string" as const,
      enum: ["tool_error", "missing_tool", "access_needed", "bad_description", "slow", "bug", "other"],
      description: "Nature du problème rencontré.",
    },
    severity: {
      type: "string" as const,
      enum: ["low", "medium", "high", "blocking"],
      default: "medium",
      description: "Gravité : « blocking » si cela t'empêche totalement d'avancer.",
    },
    title: { type: "string" as const, maxLength: 120, description: "Résumé en une ligne (≤ 120 caractères)." },
    description: {
      type: "string" as const,
      maxLength: 4000,
      description: "Ce qui s'est passé et ce qui était attendu (≤ 4 000 caractères, sans secret).",
    },
    tool: {
      type: "string" as const,
      description: "Nom public de l'outil concerné, si connu (ex. « gh__create_issue »).",
    },
    attempted_action: { type: "string" as const, description: "Ce que tu essayais de faire." },
    error_message: { type: "string" as const, description: "Le message d'erreur reçu, tel quel." },
  },
  required: ["category", "title", "description"],
};

export const REPORT_FEEDBACK_TOOL: Tool = {
  name: REPORT_FEEDBACK_NAME,
  title: "Signaler un problème",
  description: DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** Minimal structural types for the lazily imported lib/feedback.ts. */
interface FeedbackModule {
  REPORT_FEEDBACK_TOOL_DESCRIPTION?: string;
  feedbackInputSchema?: { parse: (value: unknown) => unknown };
  recordFeedback: (
    input: unknown,
    ctx: { keyId: string; sessionId?: string | null; clientInfo?: Record<string, unknown> | null },
  ) => { id: string; status: "recorded" | "merged"; occurrences: number; message: string };
  FeedbackRateLimitError?: new (...args: never[]) => Error;
  isFeedbackEnabled?: () => boolean;
}

let cached: FeedbackModule | null = null;
let loadFailed = false;

/** Loads lib/feedback.ts on first use; returns null when the module is unavailable. */
async function loadFeedback(): Promise<FeedbackModule | null> {
  if (cached) return cached;
  if (loadFailed) return null;
  try {
    const mod = (await import("../feedback")) as unknown as FeedbackModule;
    if (typeof mod.recordFeedback !== "function") {
      loadFailed = true;
      return null;
    }
    cached = mod;
    return cached;
  } catch {
    loadFailed = true;
    return null;
  }
}

/**
 * Synchronous availability probe used by tools/list. Honours the global Settings switch (§6.5)
 * and defaults to "enabled" when the settings table cannot be read.
 */
export function isFeedbackToolAvailable(): boolean {
  try {
    if (getSettings().feedbackEnabled === false) return false;
  } catch {
    /* enabled by default */
  }
  return true;
}

export interface FeedbackToolContext {
  keyId: string;
  sessionId: string;
  clientInfo: { name?: string; version?: string } | null;
}

export interface FeedbackToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Runs `report_feedback`. Never throws: invalid input and rate limits come back as
 * `isError: true` tool results with an agent-safe French message (spec §6.5).
 */
export async function runReportFeedback(
  args: Record<string, unknown> | undefined,
  ctx: FeedbackToolContext,
): Promise<FeedbackToolResult> {
  const mod = await loadFeedback();
  if (!mod) {
    return {
      content: [
        {
          type: "text",
          text:
            "Le module de retours n'est pas disponible sur cette instance de Switchboard. " +
            "Signale le problème à l'administrateur autrement.",
        },
      ],
      isError: true,
    };
  }

  try {
    const parsed = mod.feedbackInputSchema ? mod.feedbackInputSchema.parse(args ?? {}) : (args ?? {});
    const result = mod.recordFeedback(parsed, {
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      clientInfo: ctx.clientInfo ? { ...ctx.clientInfo } : null,
    });
    return {
      content: [{ type: "text", text: result.message }],
      structuredContent: {
        id: result.id,
        status: result.status,
        occurrences: result.occurrences,
      },
    };
  } catch (error) {
    if (isRateLimitError(error)) {
      return {
        content: [{ type: "text", text: (error as Error).message }],
        isError: true,
      };
    }
    if (isZodError(error)) {
      const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? [];
      const detail = issues
        .map((issue) => `- ${issue.path.join(".") || "(racine)"} : ${issue.message}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Retour refusé : arguments invalides.\n${detail}\nCorrige les champs puis réessaie (catégorie, title et description sont obligatoires).`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Le retour n'a pas pu être enregistré : ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as Error & { code?: string }).code === "feedback_rate_limit";
}

function isZodError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "ZodError" || Array.isArray((error as { issues?: unknown }).issues);
}
