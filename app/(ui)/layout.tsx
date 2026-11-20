import * as React from "react";
import { uiAuthState } from "@/components/server/auth";
import { shellCounts } from "@/components/server/data";
import { AppShell, ShellFooter } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";

/**
 * Shared shell for every admin page. Unauthenticated requests (login page, or a page that is
 * about to redirect) get a bare container so /login renders without the sidebar.
 */
export default async function UiLayout({ children }: { children: React.ReactNode }) {
  const authed = await uiAuthState();

  if (!authed) {
    return (
      <ToastProvider>
        <div className="flex min-h-screen items-center justify-center px-4 py-10">{children}</div>
      </ToastProvider>
    );
  }

  let counts = { feedbackUnread: 0, serversAuthRequired: 0, keysActive: 0, serversReady: 0, serversError: 0 };
  try {
    counts = shellCounts();
  } catch {
    /* fresh install / DB not migrated yet: render with zeroed counters */
  }

  return (
    <ToastProvider>
      <AppShell counts={{ ...counts, feedbackUnread: counts.feedbackUnread, keysActive: counts.keysActive, serversAuthRequired: counts.serversAuthRequired }}>
        {children}
        <ShellFooter />
      </AppShell>
    </ToastProvider>
  );
}
