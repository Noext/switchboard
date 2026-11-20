import * as React from "react";
import { cn } from "./cn";

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info" | "violet";

const tones: Record<Tone, string> = {
  neutral: "badge-neutral",
  accent: "badge-accent",
  ok: "badge-ok",
  warn: "badge-warn",
  bad: "badge-bad",
  info: "badge-info",
  violet: "badge-violet",
};

export function Badge({
  tone = "neutral",
  className,
  title,
  children,
}: {
  tone?: Tone;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("badge", tones[tone], className)} title={title}>
      {children}
    </span>
  );
}

const statusTones: Record<string, Tone> = {
  ready: "ok",
  connecting: "warn",
  degraded: "warn",
  auth_required: "info",
  error: "bad",
  disabled: "neutral",
  active: "ok",
  revoked: "bad",
  expired: "warn",
};

const statusLabels: Record<string, string> = {
  ready: "prêt",
  connecting: "connexion",
  degraded: "dégradé",
  auth_required: "OAuth requis",
  error: "erreur",
  disabled: "désactivé",
  active: "active",
  revoked: "révoquée",
  expired: "expirée",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={statusTones[status] ?? "neutral"} className={cn("capitalize", className)}>
      <span className={cn("status-dot", "dot-" + status)} />
      {statusLabels[status] ?? status}
    </Badge>
  );
}

const severityTone: Record<string, Tone> = {
  low: "neutral",
  medium: "info",
  high: "warn",
  blocking: "bad",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={severityTone[severity] ?? "neutral"}>{severity}</Badge>;
}

const feedbackStatusTone: Record<string, Tone> = {
  new: "bad",
  acknowledged: "info",
  in_progress: "warn",
  resolved: "ok",
  wont_fix: "neutral",
};

const feedbackStatusLabel: Record<string, string> = {
  new: "nouveau",
  acknowledged: "acknowledgé",
  in_progress: "en cours",
  resolved: "résolu",
  wont_fix: "wont fix",
};

export function FeedbackStatusBadge({ status }: { status: string }) {
  return <Badge tone={feedbackStatusTone[status] ?? "neutral"}>{feedbackStatusLabel[status] ?? status}</Badge>;
}

const categoryLabel: Record<string, string> = {
  tool_error: "outil en erreur",
  missing_tool: "outil manquant",
  access_needed: "accès nécessaire",
  bad_description: "description",
  slow: "lenteur",
  bug: "bug",
  other: "autre",
};

export function CategoryBadge({ category }: { category: string }) {
  return <Badge tone="violet">{categoryLabel[category] ?? category}</Badge>;
}

export function BoolBadge({
  value,
  trueLabel = "oui",
  falseLabel = "non",
}: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
}) {
  return <Badge tone={value ? "ok" : "neutral"}>{value ? trueLabel : falseLabel}</Badge>;
}

export function CountBadge({ count, tone = "accent" }: { count: number; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-[17px] items-center justify-center rounded-full px-1 text-[10.5px] font-bold leading-[17px]",
        tone === "bad" ? "bg-[hsl(var(--bad))] text-[#1a0508]" : "bg-[hsl(var(--panel-3))] text-ink",
      )}
    >
      {count}
    </span>
  );
}
