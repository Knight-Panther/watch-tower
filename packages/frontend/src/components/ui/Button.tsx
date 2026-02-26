import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import Spinner from "../Spinner";

type Variant = "primary" | "secondary" | "danger" | "danger-soft" | "ghost";
type Size = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingText?: string;
  fullWidth?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50",
  secondary:
    "border border-slate-700 text-slate-200 hover:border-slate-500 disabled:opacity-50",
  danger:
    "border border-red-800/60 bg-red-950/30 text-red-300 hover:border-red-600 hover:bg-red-950/50 disabled:opacity-50",
  "danger-soft":
    "bg-red-500/20 text-red-200 hover:bg-red-500/30 disabled:opacity-50",
  ghost:
    "text-slate-400 hover:text-slate-200 disabled:opacity-50",
};

const SIZE_CLASSES: Record<Size, string> = {
  xs: "px-2 py-1 text-xs",
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-2.5 text-sm font-medium",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      size = "md",
      loading = false,
      loadingText,
      fullWidth = false,
      icon,
      children,
      disabled,
      className = "",
      ...rest
    },
    ref,
  ) => {
    const base = "inline-flex items-center justify-center gap-2 rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950";
    const variantCls = VARIANT_CLASSES[variant];
    const sizeCls = SIZE_CLASSES[size];
    const widthCls = fullWidth ? "w-full" : "";

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`${base} ${variantCls} ${sizeCls} ${widthCls} ${className}`.trim()}
        {...rest}
      >
        {loading ? (
          <>
            <Spinner />
            {loadingText ?? children}
          </>
        ) : (
          <>
            {icon}
            {children}
          </>
        )}
      </button>
    );
  },
);

Button.displayName = "Button";
export default Button;
