"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import {
  IconDashboard,
  IconFeedback,
  IconImport,
  IconKey,
  IconLogs,
  IconMatrix,
  IconRoles,
  IconServer,
  IconSettings,
} from "@/components/ui/icons";

export interface NavCounts {
  feedbackUnread: number;
  serversAuthRequired: number;
  keysActive: number;
}

const items = [
  { href: "/dashboard", label: "Dashboard", icon: IconDashboard, badge: null as null | "feedback" | "servers" | "keys" },
  { href: "/servers", label: "Serveurs", icon: IconServer, badge: "servers" as const },
  { href: "/keys", label: "Clés API", icon: IconKey, badge: "keys" as const },
  { href: "/roles", label: "Rôles", icon: IconRoles, badge: null },
  { href: "/access-matrix", label: "Matrice", icon: IconMatrix, badge: null },
  { href: "/feedback", label: "Retours", icon: IconFeedback, badge: "feedback" as const },
  { href: "/logs", label: "Journal", icon: IconLogs, badge: null },
  { href: "/import", label: "Import", icon: IconImport, badge: null },
  { href: "/settings", label: "Paramètres", icon: IconSettings, badge: null },
];

export function SidebarNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname() ?? "";
  const values: Record<string, number> = {
    feedback: counts.feedbackUnread,
    servers: counts.serversAuthRequired,
    keys: counts.keysActive,
  };

  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        const count = item.badge ? values[item.badge] : 0;
        return (
          <Link key={item.href} href={item.href} className={cn("nav-link", active && "nav-link-active")}>
            <span className="flex items-center gap-2">
              <Icon className={cn("shrink-0", active ? "text-accent" : "text-muted")} />
              {item.label}
            </span>
            {count > 0 ? (
              <span
                className={cn(
                  "inline-flex min-w-[17px] items-center justify-center rounded-full px-1 text-[10.5px] font-bold leading-[17px]",
                  item.badge === "feedback" ? "bg-[hsl(var(--bad))] text-[#1a0508]" : "bg-[hsl(var(--panel-3))] text-ink",
                )}
                title={item.badge === "feedback" ? count + " retour(s) non traité(s)" : count + " élément(s)"}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm w-full justify-start text-muted"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/v1/session", { method: "DELETE", credentials: "same-origin" });
        } catch {
          /* ignore: redirect anyway */
        }
        window.location.href = "/login";
      }}
    >
      Déconnexion
    </button>
  );
}
