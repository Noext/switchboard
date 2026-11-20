import * as React from "react";
import { cn } from "./cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = "text", ...props }, ref) {
    return <input ref={ref} type={type} className={cn("input", className)} {...props} />;
  },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn("textarea mono", className)} {...props} />;
  },
);

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn("select", className)} {...props}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
});

export function Field({
  label,
  hint,
  children,
  htmlFor,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  className,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer select-none items-center gap-1.5 text-[12.5px]",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded border border-line-strong bg-[hsl(var(--bg))] checked:border-accent checked:bg-accent disabled:cursor-not-allowed"
      />
      {label ? <span className="min-w-0">{label}</span> : null}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
}) {
  return (
    <label className={cn("inline-flex cursor-pointer select-none items-center gap-2", disabled && "opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[18px] w-[32px] shrink-0 rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-line-strong bg-[hsl(var(--bg))]",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-[12px] w-[12px] rounded-full transition-all",
            checked ? "left-[17px] bg-[hsl(var(--accent-ink))]" : "left-[2px] bg-muted",
          )}
        />
      </button>
      {label ? <span className="text-[12.5px]">{label}</span> : null}
    </label>
  );
}
