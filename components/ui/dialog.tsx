"use client";

import * as React from "react";
import { cn } from "./cn";

/** Minimal modal: no portal dependency, closes on Escape / backdrop click. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-[560px]",
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        className={cn("card w-full shadow-2xl", width)}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="card-header">
          <div className="card-title text-ink">{title}</div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-xs" aria-label="Fermer">
            ✕
          </button>
        </div>
        <div className="card-body max-h-[65vh] scroll-thin overflow-y-auto">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-3.5 py-2.5">{footer}</div> : null}
      </div>
    </div>
  );
}

export function SlideOver({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onMouseDown={onClose}>
      <aside
        className="flex h-full w-full max-w-[520px] flex-col border-l border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="min-w-0">
            <div className="card-title text-ink">{title}</div>
            {subtitle ? <div className="mt-0.5 text-[11.5px] text-muted">{subtitle}</div> : null}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-xs" aria-label="Fermer">
            ✕
          </button>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-3.5">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-3.5 py-2.5">{footer}</div> : null}
      </aside>
    </div>
  );
}
