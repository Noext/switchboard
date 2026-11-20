"use client";

import * as React from "react";
import { cn } from "./cn";

type ToastTone = "info" | "ok" | "warn" | "bad";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  push: (message: string, tone?: ToastTone) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  return ctx ?? { push: () => undefined };
}

const toneClass: Record<ToastTone, string> = {
  info: "border-[hsla(210,92%,64%,0.5)] bg-[hsla(210,92%,64%,0.12)]",
  ok: "border-[hsla(152,58%,46%,0.5)] bg-[hsla(152,58%,46%,0.12)]",
  warn: "border-[hsla(40,95%,56%,0.5)] bg-[hsla(40,95%,56%,0.12)]",
  bad: "border-[hsla(356,78%,60%,0.55)] bg-[hsla(356,78%,60%,0.14)]",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const counter = React.useRef(0);

  const push = React.useCallback((message: string, tone: ToastTone = "info") => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4800);
  }, []);

  const value = React.useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[320px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto rounded-md border px-3 py-2 text-[12.5px] shadow-lg backdrop-blur",
              toneClass[t.tone],
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
