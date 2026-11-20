import { afterEach, beforeEach } from "vitest";

/**
 * Process-global singletons (lib/runtime/global.ts) outlive `vi.resetModules()`, which is what we
 * want in production (one DB handle, one manager, one catalog shared by the custom server and
 * Next's route handlers) but not between tests: every test must start from a clean slate.
 *
 * Suites that build their state in `beforeAll` (and share one HTTP server across cases) opt out by
 * calling `keepRuntimeStateForFile()` at module scope — see tests/gateway-http.test.ts.
 */

let keepForFile = false;

/** Opt out of the per-test reset for the rest of this file. */
export function keepRuntimeStateForFile(): void {
  keepForFile = true;
}

function clearRuntimeBag(): void {
  const bag = globalThis as unknown as { __switchboardRuntime?: Record<symbol, unknown> };
  if (bag.__switchboardRuntime) delete bag.__switchboardRuntime;
}

beforeEach(() => {
  if (!keepForFile) clearRuntimeBag();
});

afterEach(async () => {
  if (keepForFile) return;
  try {
    const { closeDb } = await import("../../lib/db");
    closeDb();
  } catch {
    /* no DB opened in this test */
  }
  clearRuntimeBag();
});
