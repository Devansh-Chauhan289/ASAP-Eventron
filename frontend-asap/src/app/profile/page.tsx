"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Settings,
  Bell,
  CreditCard,
  HelpCircle,
  LogOut,
  ChevronRight,
  Pencil,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EventCard } from "@/components/EventCard";
import { Reveal } from "@/components/Reveal";
import { events } from "@/lib/data";

const upcoming = events.filter((e) =>
  ["neon-pulse", "global-tech-summit"].includes(e.id),
);
const past = events.filter((e) => ["jazz-blues-night"].includes(e.id));
const saved = events.filter((e) =>
  ["modern-art-gala", "nba-all-star"].includes(e.id),
);

const SETTINGS = [
  { Icon: Bell, label: "Notifications" },
  { Icon: CreditCard, label: "Payment Methods" },
  { Icon: Settings, label: "Account Settings" },
  { Icon: HelpCircle, label: "Help & Support" },
];

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-4 text-lg font-bold text-ink-primary">{title}</h2>
      {children}
    </section>
  );
}

export default function ProfilePage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 pt-6 md:px-6">
        {/* Profile header */}
        <Reveal>
          <div className="flex flex-col items-center rounded-lg bg-white p-6 text-center card-shadow sm:flex-row sm:text-left">
            <div className="relative h-20 w-20 overflow-hidden rounded-full ring-4 ring-primary/15">
              <Image
                src="https://i.pravatar.cc/160?img=15"
                alt="Jordan Mitchell"
                fill
                sizes="80px"
                className="object-cover"
              />
            </div>
            <div className="mt-3 sm:ml-5 sm:mt-0">
              <h1 className="text-xl font-extrabold text-ink-primary">
                Jordan Mitchell
              </h1>
              <p className="text-sm text-ink-secondary">jordan@example.com</p>
            </div>
            <button className="mt-4 flex items-center gap-1.5 rounded-md border border-gray-200 px-4 py-2 text-sm font-semibold text-ink-primary hover:bg-gray-50 sm:ml-auto sm:mt-0">
              <Pencil className="h-4 w-4" /> Edit Profile
            </button>
          </div>
        </Reveal>

        {/* Upcoming */}
        <Section title="Upcoming Events">
          <div className="grid gap-4 md:grid-cols-2">
            {upcoming.map((e) => (
              <EventCard key={e.id} event={e} variant="list" />
            ))}
          </div>
        </Section>

        {/* Saved */}
        <Section title="Saved Events">
          <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
            {saved.map((e) => (
              <EventCard key={e.id} event={e} variant="compact" />
            ))}
          </div>
        </Section>

        {/* Past */}
        <Section title="Past Bookings">
          <div className="grid gap-4 md:grid-cols-2">
            {past.map((e) => (
              <EventCard key={e.id} event={e} variant="list" />
            ))}
          </div>
        </Section>

        {/* Settings */}
        <Section title="Settings">
          <div className="overflow-hidden rounded-lg bg-white card-shadow">
            {SETTINGS.map((s, i) => (
              <button
                key={s.label}
                className={`flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 ${
                  i > 0 ? "border-t border-gray-100" : ""
                }`}
              >
                <s.Icon className="h-5 w-5 text-ink-secondary" />
                <span className="flex-1 text-sm font-medium text-ink-primary">
                  {s.label}
                </span>
                <ChevronRight className="h-4 w-4 text-ink-secondary" />
              </button>
            ))}
            <Link
              href="/"
              className="flex w-full items-center gap-3 border-t border-gray-100 px-5 py-4 text-left text-tag-sale hover:bg-red-50"
            >
              <LogOut className="h-5 w-5" />
              <span className="flex-1 text-sm font-semibold">Sign Out</span>
            </Link>
          </div>
        </Section>
      </div>
    </AppShell>
  );
}