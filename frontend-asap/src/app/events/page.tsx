"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal, ChevronDown } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EventCard } from "@/components/EventCard";
import { FilterChips } from "@/components/FilterChips";
import { Reveal } from "@/components/Reveal";
import { events } from "@/lib/data";

const CATEGORIES = ["All", "Concerts", "Tech", "Sports", "Workshops", "Arts"];
const SORTS = ["Newest First", "Price: Low to High", "Price: High to Low", "Top Rated"];
const PAGE_SIZE = 4;

export default function EventsPage() {
  const [selected, setSelected] = useState<string[]>(["All"]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(SORTS[0]);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const filtered = useMemo(() => {
    let list = events.filter((e) => {
      const catOk =
        selected.includes("All") || selected.includes(e.category);
      const queryOk =
        e.title.toLowerCase().includes(query.toLowerCase()) ||
        e.city.toLowerCase().includes(query.toLowerCase());
      return catOk && queryOk;
    });

    const priceOf = (p: typeof events[number]["price"]) => p?.amount ?? 0;
    switch (sort) {
      case "Price: Low to High":
        list = [...list].sort((a, b) => priceOf(a.price) - priceOf(b.price));
        break;
      case "Price: High to Low":
        list = [...list].sort((a, b) => priceOf(b.price) - priceOf(a.price));
        break;
      case "Top Rated":
        list = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        break;
      default:
        list = [...list].sort((a, b) => b.isoDate.localeCompare(a.isoDate));
    }
    return list;
  }, [selected, query, sort]);

  const shown = filtered.slice(0, visible);
  const hasMore = visible < filtered.length;

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6">
        <Reveal>
          <h1 className="text-2xl font-extrabold text-ink-primary md:text-3xl">
            All Events
          </h1>
        </Reveal>

        {/* Search */}
        <Reveal delay={0.05} className="mt-4">
          <div className="flex items-center gap-3 rounded-md bg-white px-4 py-3 card-shadow">
            <Search className="h-5 w-5 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisible(PAGE_SIZE);
              }}
              placeholder="Search events, cities, artists..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-secondary"
            />
          </div>
        </Reveal>

        <div className="mt-6 flex gap-8">
          {/* Desktop sidebar filters */}
          <aside className="hidden w-56 shrink-0 lg:block">
            <div className="sticky top-24 rounded-lg bg-white p-5 card-shadow">
              <div className="mb-4 flex items-center gap-2 font-semibold text-ink-primary">
                <SlidersHorizontal className="h-4 w-4" />
                Filters
              </div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                Category
              </p>
              <div className="flex flex-col gap-2">
                {CATEGORIES.map((cat) => {
                  const active = selected.includes(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        setSelected(
                          cat === "All"
                            ? ["All"]
                            : active
                              ? selected.filter((c) => c !== cat)
                              : [...selected.filter((c) => c !== "All"), cat],
                        );
                        setVisible(PAGE_SIZE);
                      }}
                      className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "bg-primary-50 font-semibold text-primary"
                          : "text-ink-secondary hover:bg-gray-50"
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            {/* Mobile chips */}
            <div className="lg:hidden">
              <FilterChips
                options={CATEGORIES}
                value={selected}
                onChange={(v) => {
                  setSelected(v as string[]);
                  setVisible(PAGE_SIZE);
                }}
                multiSelect
              />
            </div>

            {/* Results count + sort */}
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-ink-secondary">
                <span className="font-semibold text-ink-primary">
                  {filtered.length}
                </span>{" "}
                events found
              </p>
              <div className="relative">
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm font-medium text-ink-primary outline-none"
                >
                  {SORTS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-secondary" />
              </div>
            </div>

            {/* List */}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {shown.map((e, i) => (
                <Reveal key={e.id} delay={(i % PAGE_SIZE) * 0.05}>
                  <EventCard event={e} variant="list" />
                </Reveal>
              ))}
            </div>

            {shown.length === 0 && (
              <div className="mt-12 text-center text-ink-secondary">
                No events match your filters.
              </div>
            )}

            {hasMore && (
              <div className="mt-8 flex justify-center">
                <button
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="rounded-md border border-primary bg-white px-6 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-50"
                >
                  Load More Events
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}