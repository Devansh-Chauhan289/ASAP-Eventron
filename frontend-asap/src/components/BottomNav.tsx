"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Home,
  Compass,
  Plus,
  LayoutDashboard,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/home", label: "Home", Icon: Home },
  { href: "/events", label: "Explore", Icon: Compass },
  { href: "/checkout", label: "Add", Icon: Plus, primary: true },
  { href: "/dashboard", label: "Trips", Icon: LayoutDashboard },
  { href: "/profile", label: "Profile", Icon: User },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-100 bg-white/95 backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-md items-center justify-around px-2 py-1.5">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);

          if (tab.primary) {
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className="flex flex-col items-center"
              >
                <motion.span
                  whileTap={{ scale: 0.85 }}
                  className="flex h-12 w-12 -translate-y-3 items-center justify-center rounded-full bg-primary text-white shadow-lg shadow-primary/30"
                >
                  <tab.Icon className="h-6 w-6" />
                </motion.span>
              </Link>
            );
          }

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="relative flex flex-1 flex-col items-center gap-0.5 py-1.5"
            >
              <motion.div whileTap={{ scale: 0.85 }}>
                <tab.Icon
                  className={cn(
                    "h-5 w-5 transition-colors",
                    active ? "text-primary" : "text-ink-secondary",
                  )}
                  fill={active ? "currentColor" : "none"}
                />
              </motion.div>
              <span
                className={cn(
                  "text-[10px] font-medium",
                  active ? "text-primary" : "text-ink-secondary",
                )}
              >
                {tab.label}
              </span>
              {active && (
                <motion.span
                  layoutId="bottomnav-underline"
                  className="absolute -bottom-0 h-0.5 w-8 rounded-full bg-primary"
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}