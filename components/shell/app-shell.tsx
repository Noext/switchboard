import * as React from "react";
import Link from "next/link";
import { LogoutButton, SidebarNav, type NavCounts } from "./sidebar-nav";
import { config } from "@/lib/config";
import { getSettings } from "@/lib/settings";

/**
 * Admin console shell: fixed left sidebar, dense header, content area.
 * Rendered by app/(ui)/layout.tsx for authenticated users only.
 */
export function AppShell({ counts, children }: { counts: NavCounts; children: React.ReactNode }) {
  let publicUrl = config.publicUrl;
  try {
    publicUrl = getSettings().publicUrl || config.publicUrl;
  } catch {
    /* DB not ready yet: fall back to env */
  }

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 flex w-[212px] flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-3 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-[hsl(var(--accent-ink))]">
            S
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-tight">Switchboard</div>
            <div className="truncate text-[10.5px] text-muted">passerelle MCP</div>
          </div>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-2 py-2">
          <SidebarNav counts={counts} />
        </div>

        <div className="border-t border-line px-2 py-2">
          <div className="mb-1.5 truncate px-2.5 text-[10.5px] text-muted" title={publicUrl}>
            {publicUrl.replace(/^https?:\/\//, "")}
          </div>
          <LogoutButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pl-[212px]">
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 py-4">{children}</main>
      </div>
    </div>
  );
}

export function ShellFooter() {
  return (
    <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-muted">
      <span>Switchboard — passerelle MCP unique</span>
      <a href="/healthz" className="link" target="_blank" rel="noreferrer">
        /healthz
      </a>
    </footer>
  );
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="text-muted">/</span> : null}
          {item.href ? (
            <Link href={item.href} className="link">
              {item.label}
            </Link>
          ) : (
            <span>{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </span>
  );
}
