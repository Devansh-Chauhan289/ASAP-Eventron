"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Sparkles,
  Plane,
  CreditCard,
  Search,
  CalendarCheck,
  Route,
  Ticket,
  Star,
} from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { EventCard } from "@/components/EventCard";
import { Reveal } from "@/components/Reveal";
import { featuredEvents } from "@/lib/data";

const FEATURES = [
  {
    Icon: Search,
    title: "Smart Event Discovery",
    body: "Personalized recommendations surface the concerts, summits and festivals you'll actually love — filtered by your taste and your city.",
  },
  {
    Icon: Plane,
    title: "AI Travel Planning",
    body: "ASAP Intelligence builds the optimal route to every event, balancing price, speed and the perfect pre-show arrival buffer.",
  },
  {
    Icon: CreditCard,
    title: "Seamless Checkout",
    body: "Tickets, transport and hotels in one secure, PCI-compliant flow. Pay once — we handle the rest end to end.",
  },
];

const STEPS = [
  { Icon: Search, title: "Discover", body: "Browse curated events near you." },
  { Icon: Ticket, title: "Book Tickets", body: "Pick your tier and quantity." },
  { Icon: Route, title: "Plan Travel", body: "Get smart transport suggestions." },
  { Icon: CalendarCheck, title: "Go", body: "Everything in one dashboard." },
];

const TESTIMONIALS = [
  {
    name: "Priya Sharma",
    role: "Festival-goer",
    body: "Booked tickets and my LA→NYC flight in under five minutes. The arrival buffer suggestion was spot on.",
  },
  {
    name: "Daniel Reyes",
    role: "Conference attendee",
    body: "ASAP planned my entire Tokyo trip around the Global Tech Summit. The dashboard kept everything in one place.",
  },
  {
    name: "Mei Tanaka",
    role: "Frequent traveler",
    body: "The transport intelligence is genuinely smart — it picked the option that 94% of users chose, and it was right.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg">
      <Navbar />

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-bg-dark">
        {/* floating gradient orbs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-20 top-10 h-72 w-72 animate-float rounded-full bg-primary/40 blur-3xl" />
          <div className="absolute right-0 top-40 h-96 w-96 animate-float-slow rounded-full bg-tag-recommended/30 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-80 w-80 animate-float rounded-full bg-tag-best/30 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-7xl px-6 py-28 text-center md:py-36">
          <motion.span
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm font-medium text-white/80"
          >
            <Sparkles className="h-4 w-4 text-tag-lowprice" />
            Powered by ASAP Intelligence
          </motion.span>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mx-auto mt-6 max-w-4xl text-4xl font-extrabold leading-tight text-white md:text-6xl"
          >
            Plan Events. Book Travel.
            <br />
            <span className="bg-gradient-to-r from-primary-100 via-white to-tag-recommended bg-clip-text text-transparent">
              All in One Place.
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mx-auto mt-6 max-w-2xl text-lg text-white/70"
          >
            Discover unforgettable events, get AI-optimized travel routes, and
            check out — tickets, flights and hotels — in a single seamless flow.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Link
              href="/events"
              className="w-full rounded-md bg-primary px-8 py-3.5 text-base font-semibold text-white transition-colors hover:bg-primary-600 sm:w-auto"
            >
              Explore Events
            </Link>
            <Link
              href="/dashboard"
              className="w-full rounded-md border border-white/20 bg-white/5 px-8 py-3.5 text-base font-semibold text-white backdrop-blur transition-colors hover:bg-white/10 sm:w-auto"
            >
              Plan a Trip
            </Link>
          </motion.div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold text-ink-primary">
            Everything for the perfect trip
          </h2>
          <p className="mt-3 text-ink-secondary">
            Three pillars working together so you never juggle five tabs again.
          </p>
        </Reveal>

        <div className="grid gap-6 md:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.1}>
              <div className="h-full rounded-lg bg-white p-7 card-shadow">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-primary-50 text-primary">
                  <f.Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-5 text-lg font-bold text-ink-primary">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
                  {f.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── FEATURED EVENTS ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-7xl px-6">
          <Reveal className="mb-8 flex items-end justify-between">
            <div>
              <h2 className="text-3xl font-bold text-ink-primary">
                Featured Events
              </h2>
              <p className="mt-2 text-ink-secondary">
                Trending right now across every city.
              </p>
            </div>
            <Link
              href="/events"
              className="hidden text-sm font-semibold text-primary hover:underline sm:block"
            >
              View all →
            </Link>
          </Reveal>

          <div className="no-scrollbar flex gap-5 overflow-x-auto pb-4">
            {featuredEvents.map((event) => (
              <EventCard key={event.id} event={event} variant="featured" />
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="mb-12 text-center">
          <h2 className="text-3xl font-bold text-ink-primary">How it works</h2>
          <p className="mt-3 text-ink-secondary">Four steps from idea to arrival.</p>
        </Reveal>

        <div className="grid gap-6 md:grid-cols-4">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.1}>
              <div className="relative rounded-lg bg-white p-6 text-center card-shadow">
                <span className="absolute right-4 top-3 text-4xl font-extrabold text-primary-50">
                  {i + 1}
                </span>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white">
                  <s.Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 font-bold text-ink-primary">{s.title}</h3>
                <p className="mt-1 text-sm text-ink-secondary">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-7xl px-6">
          <Reveal className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-ink-primary">
              Loved by travelers
            </h2>
            <p className="mt-3 text-ink-secondary">
              Join thousands planning smarter with ASAP.
            </p>
          </Reveal>

          <div className="grid gap-6 md:grid-cols-3">
            {TESTIMONIALS.map((t, i) => (
              <Reveal key={t.name} delay={i * 0.1}>
                <div className="h-full rounded-lg bg-bg p-7">
                  <div className="flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <Star
                        key={j}
                        className="h-4 w-4 fill-amber-400 text-amber-400"
                      />
                    ))}
                  </div>
                  <p className="mt-4 text-sm leading-relaxed text-ink-primary">
                    “{t.body}”
                  </p>
                  <div className="mt-5">
                    <p className="font-semibold text-ink-primary">{t.name}</p>
                    <p className="text-xs text-ink-secondary">{t.role}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <Reveal>
          <div className="relative overflow-hidden rounded-lg bg-bg-dark px-8 py-16 text-center">
            <div className="pointer-events-none absolute -right-10 -top-10 h-60 w-60 animate-float rounded-full bg-primary/40 blur-3xl" />
            <h2 className="relative text-3xl font-bold text-white">
              Ready to plan your next adventure?
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-white/70">
              Start exploring events and let ASAP handle the logistics.
            </p>
            <Link
              href="/home"
              className="relative mt-8 inline-block rounded-md bg-primary px-8 py-3.5 font-semibold text-white transition-colors hover:bg-primary-600"
            >
              Get Started Free
            </Link>
          </div>
        </Reveal>
      </section>

      <Footer />
    </div>
  );
}