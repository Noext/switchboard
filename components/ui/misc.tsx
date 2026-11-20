import * as React from "react";
import { cn } from "./cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent",
        className,
      )}
      role="status"
      aria-label="chargement"
    />
  );
}

export function Mono({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span className={cn("mono", className)} title={title}>
      {children}
    </span>
  );
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "scroll-thin max-h-[420px] overflow-auto rounded-md border border-line bg-[hsl(var(--bg))] p-2.5 mono text-[11.5px] leading-relaxed",
        className,
      )}
    >
      <code>{children}</code>
    </pre>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "ok" | "warn" | "bad";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn("callout", "callout-" + tone)}>
      <div className="min-w-0 flex-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(Boolean(title) && "mt-1", "text-muted")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("my-3 border-line", className)} />;
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "ok" | "warn" | "bad" }) {
  const pct = Math.max(0, Math.min(100, value));
  const color =
    tone === "ok"
      ? "hsl(var(--ok))"
      : tone === "warn"
        ? "hsl(var(--warn))"
        : tone === "bad"
          ? "hsl(var(--bad))"
          : "hsl(var(--accent))";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--panel-3))]">
      <div className="h-full rounded-full transition-all" style={{ width: pct + "%", background: color }} />
    </div>
  );
}
