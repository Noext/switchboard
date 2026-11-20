import * as React from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("card-header", className)}>
      <div className="min-w-0">
        {title ? <div className="card-title">{title}</div> : null}
        {subtitle ? <div className="mt-0.5 text-[12px] text-muted">{subtitle}</div> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card-body", className)} {...props} />;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <header className="mb-4 border-b border-line pb-3">
      {breadcrumb ? <div className="mb-1.5 text-[11.5px] text-muted">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold leading-tight tracking-tight">{title}</h1>
          {description ? <p className="mt-1 max-w-[75ch] text-[12.5px] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-10 text-center", className)}>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {description ? <div className="max-w-[52ch] text-[12px] text-muted">{description}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "bad" | "info";
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : tone === "info"
            ? "text-info"
            : "";
  return (
    <div className="surface px-3 py-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={cn("mt-1 text-[21px] font-semibold leading-none tabular-nums", toneClass)}>{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}
