// ─────────────────────────────────────────────────────────────
// Shared domain types for ASAP Eventron.
// Money is always { amount: <integer minor units>, currency } — never a float.
// ─────────────────────────────────────────────────────────────

export interface Money {
  amount: number; // integer minor units (cents)
  currency: string; // ISO 4217, e.g. "USD"
}

export type TagKind =
  | "best"
  | "fastest"
  | "lowprice"
  | "recommended"
  | "sale"
  | "free"
  | "soldout";

export type EventCategory =
  | "Concerts"
  | "Tech"
  | "Sports"
  | "Festivals"
  | "Workshops"
  | "Arts";

export interface Artist {
  id: string;
  name: string;
  avatar: string;
}

export interface Review {
  id: string;
  author: string;
  avatar: string;
  rating: number;
  date: string;
  body: string;
}

export interface TicketTier {
  id: string;
  name: string;
  price: Money;
  description: string;
  perks: string[];
  available: number; // 0 => sold out
  refundable: boolean;
  transferable: boolean;
}

export interface EventItem {
  id: string;
  slug: string;
  title: string;
  category: EventCategory;
  date: string; // human readable
  isoDate: string;
  time?: string;
  venue: string;
  city: string;
  image: string;
  price: Money | null; // null => free
  rating?: number;
  reviewCount?: number;
  attendees?: number;
  host?: string;
  soldOut?: boolean;
  onSale?: boolean;
  description?: string;
  capacity?: number;
  genres?: string[];
  artists?: Artist[];
  ticketTiers?: TicketTier[];
  reviews?: Review[];
}

export interface TransportOption {
  id: string;
  mode: "flight" | "train";
  icon: string;
  carrier: string;
  code: string;
  origin: string;
  originCode: string;
  destination: string;
  destinationCode: string;
  depart: string;
  arrive: string;
  duration: string;
  stops: number;
  price: Money;
  tag?: TagKind;
  note?: string;
  noteTone?: "positive" | "warning" | "danger";
  recommended?: boolean;
}

export interface Hotel {
  id: string;
  name: string;
  image: string;
  rating: number;
  distance: string; // e.g. "0.4 mi from venue"
  pricePerNight: Money;
  amenities: string[];
}

export type TimelineKind = "transport" | "event" | "stay" | "food";

export interface TimelineItemData {
  id: string;
  kind: TimelineKind;
  time: string;
  title: string;
  subtitle: string;
}

export interface TripDay {
  day: number;
  label: string;
  items: TimelineItemData[];
}

export interface Trip {
  id: string;
  name: string;
  days: number;
  stops: number;
  hotels: number;
  flights: number;
  dateRange: string;
  itinerary: TripDay[];
}

// ── API envelope types ────────────────────────────────────────
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Paginated<T> {
  data: T[];
  pageInfo: PageInfo;
}

export interface ActionDescriptor {
  enabled: boolean;
  href?: string;
  method?: string;
}

export type TripBookingStatus =
  | "DRAFT"
  | "PENDING"
  | "BOOKING_IN_PROGRESS"
  | "CONFIRMED"
  | "PARTIALLY_BOOKED"
  | "PAYMENT_FAILED"
  | "CANCELLED";

export interface TripResource {
  id: string;
  status: TripBookingStatus;
  total: Money;
  _actions: {
    confirm: ActionDescriptor;
    cancel: ActionDescriptor;
    [key: string]: ActionDescriptor;
  };
  failedLegs?: { name: string; reason: string; refund: Money }[];
}