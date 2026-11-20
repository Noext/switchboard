import * as React from "react";
import { cn } from "./cn";

export function TableWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("scroll-thin overflow-x-auto", className)}>{children}</div>;
}

export function Table({ children, className, zebra }: { children: React.ReactNode; className?: string; zebra?: boolean }) {
  return <table className={cn("table", zebra && "table-zebra", className)}>{children}</table>;
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead>{children}</thead>;
}

export function TH({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <th scope="col" className={className} colSpan={colSpan}>
      {children}
    </th>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TR({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr className={cn(onClick && "cursor-pointer", className)} onClick={onClick}>
      {children}
    </tr>
  );
}

export function TD({
  children,
  className,
  title,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  title?: string;
  colSpan?: number;
}) {
  return (
    <td className={className} title={title} colSpan={colSpan}>
      {children}
    </td>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-[12px] text-muted">
        {children}
      </td>
    </tr>
  );
}
