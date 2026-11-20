"use client";

import * as React from "react";
import { cn } from "./cn";

export interface TabItem {
  id: string;
  label: string;
  badge?: React.ReactNode;
}

/**
 * URL-driven tabs: server components render only the active panel, links are shareable.
 */
export function TabNav({
  tabs,
  active,
  basePath,
  param = "tab",
}: {
  tabs: TabItem[];
  active: string;
  basePath: string;
  param?: string;
}) {
  return (
    <div className="scroll-thin -mb-px flex gap-0.5 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <a
          key={t.id}
          href={basePath + "?" + param + "=" + encodeURIComponent(t.id)}
          className={cn("tab", active === t.id && "tab-active")}
        >
          {t.label}
          {t.badge !== undefined ? <span className="text-[11px] text-muted">{t.badge}</span> : null}
        </a>
      ))}
    </div>
  );
}

export interface SegmentOption {
  value: string;
  label: string;
}

/** Small segmented control used by the access editor (Aucun / Tous / Sélection). */
export function Segmented({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  options: SegmentOption[];
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-md border border-line bg-[hsl(var(--bg))] p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2 py-1 text-[11.5px] font-medium transition-colors",
            value === o.value ? "bg-accent text-[hsl(var(--accent-ink))]" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
