import { cn } from "@/lib/utils";
import { Network } from "lucide-react";

const brandSize: Record<"sm" | "md" | "lg", { icon: string; text: string; gap: string }> = {
  sm: { icon: "h-8 w-8", text: "text-sm", gap: "gap-2.5" },
  md: { icon: "h-10 w-10", text: "text-base", gap: "gap-3" },
  lg: { icon: "h-12 w-12", text: "text-lg", gap: "gap-3.5" },
};

interface BrandMarkProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** Lockup Vilo × Búho reutilizable en headers y footers de marca. */
export function BrandMark({ size = "md", className }: BrandMarkProps) {
  const styles = brandSize[size];
  return (
    <div className={cn("flex items-center", styles.gap, className)} aria-label="Vilo y Búho">
      <span
        className={cn(
          "grid flex-none place-items-center rounded-xl bg-accent text-accent-foreground shadow-sm",
          styles.icon,
        )}
      >
        <Network className="h-1/2 w-1/2" strokeWidth={2.4} />
      </span>
      <span
        className={cn("font-display font-semibold tracking-tight text-foreground", styles.text)}
      >
        VILO <span className="font-normal text-muted-foreground">×</span> BÚHO
      </span>
    </div>
  );
}

const badgePadding: Record<"sm" | "md" | "lg", string> = {
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

/** Panel de vidrio que envuelve el BrandMark, reemplaza al ícono genérico usado en headers de páginas públicas. */
export function BrandBadge({ size = "lg", className }: BrandMarkProps) {
  return (
    <div
      className={cn(
        "grid place-items-center rounded-2xl border border-border/60 bg-card/80 shadow-glow-primary backdrop-blur-sm",
        badgePadding[size],
        className,
      )}
    >
      <BrandMark size={size} />
    </div>
  );
}
