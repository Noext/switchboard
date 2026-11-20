export type ClassValue = string | number | null | undefined | false | ClassValue[];

/** Tiny classnames helper (no dependency, keeps server/client components identical). */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v && v !== 0) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    out.push(String(v));
  };
  for (const v of values) walk(v);
  return out.join(" ");
}
