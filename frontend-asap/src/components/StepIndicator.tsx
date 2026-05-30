"use client";

import { Check } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface StepIndicatorProps {
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
}

export function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div className="flex items-center">
      {steps.map((label, i) => {
        const completed = i < current;
        const active = i === current;
        return (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <motion.div
                initial={false}
                animate={{
                  scale: active ? 1.1 : 1,
                  backgroundColor: completed || active ? "#3F51B5" : "#E5E7EB",
                }}
                className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-white"
              >
                {completed ? <Check className="h-4 w-4" /> : i + 1}
              </motion.div>
              <span
                className={cn(
                  "mt-1.5 text-xs font-medium",
                  active || completed ? "text-primary" : "text-ink-secondary",
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="mx-2 h-0.5 flex-1 rounded-full bg-gray-200">
                <motion.div
                  initial={false}
                  animate={{ width: completed ? "100%" : "0%" }}
                  className="h-full rounded-full bg-primary"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}