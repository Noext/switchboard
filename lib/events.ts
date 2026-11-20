import { EventEmitter } from "node:events";
import { globalSingleton } from "./runtime/global";

export type UiEvent =
  | { type: "upstream.status"; data: unknown }
  | { type: "upstream.items"; data: unknown }
  | { type: "catalog.changed"; data: unknown }
  | { type: "key.changed"; data: unknown }
  | { type: "grant.changed"; data: unknown }
  | { type: "feedback.changed"; data: unknown }
  | { type: "call.logged"; data: unknown }
  | { type: "discovery.new"; data: unknown }
  | { type: "session.changed"; data: unknown }
  | { type: "ping"; data: null };

class UiBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
}

const BUS_KEY = "ui-event-bus";

/** One bus per process so SSE subscribers in Next see events emitted by the MCP server. */
export function getUiBus(): UiBus {
  return globalSingleton<UiBus>(BUS_KEY, () => new UiBus());
}

export function emitUiEvent(type: UiEvent["type"], data: unknown): void {
  getUiBus().emit("event", { type, data, at: Date.now() } as UiEvent & { at: number });
}

export function onUiEvent(listener: (e: UiEvent & { at: number }) => void): () => void {
  const b = getUiBus();
  b.on("event", listener);
  return () => b.off("event", listener);
}
