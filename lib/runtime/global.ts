/**
 * Process-global singletons.
 *
 * Switchboard runs two module graphs in one process:
 *   1. `dist/server.js` — the esbuild bundle that mounts /mcp (gateway, upstream manager).
 *   2. Next.js' own server bundle — every `app/**` route handler and server component.
 *
 * Both import the same `lib/*` files, but each graph gets its own module instances. Any state
 * that must be shared (the upstream manager, the catalog snapshot, the DB handle, the redactor,
 * the UI event bus) therefore has to live on `globalThis`, keyed by a process-wide symbol.
 *
 * Without this, creating an upstream through /api/v1 would update the DB but never reach the
 * manager that serves /mcp — the upstream would stay "connecting" forever.
 */

type Store = Record<symbol, unknown>;

function store(): Store {
  const bag = globalThis as unknown as { __switchboardRuntime?: Store };
  if (!bag.__switchboardRuntime) bag.__switchboardRuntime = {};
  return bag.__switchboardRuntime;
}

/** Returns the process-wide value for `key`, creating it on first access. */
export function globalSingleton<T>(key: string, factory: () => T): T {
  const symbol = Symbol.for(`switchboard:${key}`);
  const bag = store();
  if (!(symbol in bag)) bag[symbol] = factory();
  return bag[symbol] as T;
}

/** Replaces a process-wide value (tests, re-initialisation). */
export function setGlobalSingleton<T>(key: string, value: T): void {
  store()[Symbol.for(`switchboard:${key}`)] = value;
}

/** Reads a process-wide value without creating it. */
export function peekGlobalSingleton<T>(key: string): T | undefined {
  return store()[Symbol.for(`switchboard:${key}`)] as T | undefined;
}

/** Drops a process-wide value (tests). */
export function clearGlobalSingleton(key: string): void {
  delete store()[Symbol.for(`switchboard:${key}`)];
}
