"use client";

import { cn } from "@/lib/utils";

interface FilterChipsProps {
  options: string[];
  /** Active value(s). For single select pass a string; for multi pass an array. */
  value: string | string[];
  onChange: (value: string | string[]) => void;
  multiSelect?: boolean;
  className?: string;
}

export function FilterChips({
  options,
  value,
  onChange,
  multiSelect = false,
  className,
}: FilterChipsProps) {
  const isActive = (opt: string) =>
    multiSelect ? (value as string[]).includes(opt) : value === opt;

  const handleClick = (opt: string) => {
    if (!multiSelect) {
      onChange(opt);
      return;
    }
    const current = value as string[];
    // "All" resets the multi-select.
    if (opt === "All") {
      onChange(["All"]);
      return;
    }
    const next = current.includes(opt)
      ? current.filter((o) => o !== opt)
      : [...current.filter((o) => o !== "All"), opt];
    onChange(next.length ? next : ["All"]);
  };

  return (
    <div
      className={cn(
        "no-scrollbar flex gap-2 overflow-x-auto pb-1",
        className,
      )}
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => handleClick(opt)}
          className={cn(
            "whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition-colors",
            isActive(opt)
              ? "border-primary bg-primary text-white shadow-sm"
              : "border-gray-200 bg-white text-ink-secondary hover:border-primary/40 hover:text-primary",
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}