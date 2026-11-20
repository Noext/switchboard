import * as React from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm" | "xs";

const variants: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

const sizes: Record<Size, string> = {
  md: "",
  sm: "btn-sm",
  xs: "btn-xs",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn("btn", variants[variant], sizes[size], className)} {...props} />;
});

export function LinkButton({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  return <a className={cn("btn", variants[variant], sizes[size], className)} {...props} />;
}
