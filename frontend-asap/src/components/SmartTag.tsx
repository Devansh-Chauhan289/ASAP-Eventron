import { cn } from "@/lib/utils";
import type { TagKind } from "@/lib/types";

interface TagConfig {
  label: string;
  className: string;
}

const CONFIG: Record<TagKind, TagConfig> = {
  best: { label: "Best Option", className: "bg-[#4F46E5] text-white" },
  fastest: { label: "Fastest", className: "bg-[#22C55E] text-white" },
  lowprice: { label: "Lowest Price", className: "bg-[#F59E0B] text-white" },
  recommended: { label: "Recommended", className: "bg-[#9333EA] text-white" },
  sale: { label: "On Sale", className: "bg-[#EF4444] text-white" },
  free: { label: "Free", className: "bg-[#10B981] text-white" },
  soldout: { label: "Sold Out", className: "bg-[#9CA3AF] text-white" },
};

interface SmartTagProps {
  kind: TagKind;
  /** Override the default label text. */
  label?: string;
  /** Pulse animation (used for "Best Option"). */
  pulse?: boolean;
  className?: string;
}

export function SmartTag({ kind, label, pulse, className }: SmartTagProps) {
  const cfg = CONFIG[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold tracking-wide",
        cfg.className,
        pulse && "animate-pulse-tag",
        className,
      )}
    >
      {label ?? cfg.label}
    </span>
  );
}