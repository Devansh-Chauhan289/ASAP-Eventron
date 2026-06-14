import type {
  EventCategory,
  EventDateOption,
  EventItem,
  Money,
  TicketTier,
} from "./types";

// ─────────────────────────────────────────────────────────────
// Maps the backend's normalized event (provider ACL → Ticketmaster Discovery)
// into the frontend's richer EventItem. Fields Ticketmaster doesn't provide
// (artists, reviews, capacity, real ratings) are left empty or given neutral
// placeholder defaults so the existing UI renders cleanly.
// ─────────────────────────────────────────────────────────────

export interface ApiEvent {
  id: string;
  provider: string;
  externalId: string;
  title: string;
  category: string;
  venue: { name: string; city: string | null; lat: number | null; lng: number | null };
  startsAt: string | null;
  endsAt: string | null;
  priceFrom: { amount: number; currency: string } | null;
  imageUrl: string | null;
  availability: "AVAILABLE" | "LIMITED" | "SOLD_OUT" | "UNKNOWN";
  dates?: Array<{
    externalId: string;
    startsAt: string | null;
    availability: "AVAILABLE" | "LIMITED" | "SOLD_OUT" | "UNKNOWN";
  }>;
}

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1200&q=80";

function mapCategory(segment: string): EventCategory {
  const s = segment.toLowerCase();
  if (s.includes("music")) return "Concerts";
  if (s.includes("sport")) return "Sports";
  if (s.includes("art") || s.includes("theatre") || s.includes("film")) return "Arts";
  if (s.includes("misc") || s.includes("festival")) return "Festivals";
  return "Concerts";
}

function formatDate(iso: string | null): { date: string; isoDate: string; time?: string } {
  if (!iso) return { date: "Date TBA", isoDate: "" };
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const isoDate = iso.slice(0, 10);
  // Show a time only when the source actually carried one (TM uses 00:00 when unknown).
  const hasTime = !(d.getUTCHours() === 0 && d.getUTCMinutes() === 0);
  const time = hasTime
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : undefined;
  return { date, isoDate, time };
}

// Deterministic pseudo-rating (4.3–4.8) so the UI shows a plausible number rather
// than "undefined". Clearly a placeholder — real ratings would come from a reviews source.
function pseudoRating(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 4.3 + (h % 6) / 10;
}

export function mapApiEvent(raw: ApiEvent): EventItem {
  const { date, isoDate, time } = formatDate(raw.startsAt);
  const soldOut = raw.availability === "SOLD_OUT";
  const price: Money | null = raw.priceFrom
    ? { amount: raw.priceFrom.amount, currency: raw.priceFrom.currency }
    : null;

  // Always provide at least one ticket tier so the detail page + booking flow work.
  const tierPrice: Money = price ?? { amount: 7500, currency: "USD" };
  const ticketTiers: TicketTier[] = [
    {
      id: "ga",
      name: "General Admission",
      price: tierPrice,
      description: "Standard entry",
      perks: ["Entry to the event"],
      available: soldOut ? 0 : 200,
      refundable: true,
      transferable: true,
    },
  ];

  // Map every performance of the show into a selectable date option.
  const dates: EventDateOption[] = (raw.dates ?? [
    { externalId: raw.externalId, startsAt: raw.startsAt, availability: raw.availability },
  ]).map((d) => {
    const f = formatDate(d.startsAt);
    return {
      externalId: d.externalId,
      startsAt: d.startsAt,
      date: f.date,
      time: f.time,
      soldOut: d.availability === "SOLD_OUT",
    };
  });

  const multiDate = dates.length > 1;

  return {
    id: raw.externalId,
    slug: raw.externalId,
    title: raw.title,
    category: mapCategory(raw.category),
    date,
    isoDate,
    time,
    venue: raw.venue.name,
    city: raw.venue.city ?? "",
    image: raw.imageUrl ?? FALLBACK_IMAGE,
    price,
    rating: Number(pseudoRating(raw.externalId).toFixed(1)),
    reviewCount: 0,
    host: "Ticketmaster",
    soldOut,
    onSale: raw.availability === "AVAILABLE",
    description: `${raw.title} at ${raw.venue.name}${raw.venue.city ? `, ${raw.venue.city}` : ""}. ${
      multiDate ? `${dates.length} dates available. ` : ""
    }Tickets via Ticketmaster.`,
    ticketTiers,
    artists: [],
    reviews: [],
    genres: [raw.category],
    dates,
  };
}
