"use client";

import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { ChevronLeft, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { StepIndicator } from "@/components/StepIndicator";
import { StripePaymentStep } from "@/components/checkout/StripePaymentStep";
import { BookingProgress } from "@/components/checkout/BookingProgress";
import { formatMoney } from "@/lib/money";
import { api } from "@/lib/api";
import type { Money } from "@/lib/types";

const STEPS = ["Tickets", "Details", "Payment", "Confirm"];
const PROMO_RATE = 0.1; // NEON10 = 10% off
const SERVICE_FEE = 650; // $6.50 in minor units

interface SelectionLine {
  tierId: string;
  name: string;
  qty: number;
  price: Money;
}

interface CheckoutData {
  eventId: string;
  eventTitle: string;
  date: string;
  venue: string;
  selection: SelectionLine[];
  promo: string;
}

const DEMO: CheckoutData = {
  eventId: "neon-pulse",
  eventTitle: "Neon Pulse Music Festival 2025",
  date: "Dec 14, 2025",
  venue: "Madison Square Garden",
  selection: [
    {
      tierId: "ga",
      name: "General Admission",
      qty: 2,
      price: { amount: 8500, currency: "USD" },
    },
  ],
  promo: "NEON10",
};

interface DetailsForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isHolder: boolean;
}

export default function CheckoutPage() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [data, setData] = useState<CheckoutData>(DEMO);
  // Real backend trip + payment intent created when the user reaches the Payment step.
  const [tripId, setTripId] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DetailsForm>({
    defaultValues: {
      firstName: "Jordan",
      lastName: "Mitchell",
      email: "jordan@example.com",
      phone: "",
      isHolder: true,
    },
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = sessionStorage.getItem("asap.checkout");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CheckoutData;
        if (parsed.selection?.length) setData(parsed);
      } catch {
        /* keep demo */
      }
    }
  }, []);

  const currency = data.selection[0]?.price.currency ?? "USD";
  const subtotalAmount = data.selection.reduce(
    (sum, l) => sum + l.price.amount * l.qty,
    0,
  );
  const promoApplied = data.promo?.toUpperCase() === "NEON10";
  const discountAmount = promoApplied
    ? Math.round(subtotalAmount * PROMO_RATE)
    : 0;
  const totalAmount = subtotalAmount - discountAmount + SERVICE_FEE;

  const discount: Money = { amount: discountAmount, currency };
  const fee: Money = { amount: SERVICE_FEE, currency };
  const total: Money = { amount: totalAmount, currency };

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(next);
  };

  const totalTickets = useMemo(
    () => data.selection.reduce((n, l) => n + l.qty, 0),
    [data.selection],
  );

  // Create the real backend trip once the user reaches the Payment step (idempotent guard).
  useEffect(() => {
    if (step !== 2 || tripId || creatingRef.current) return;
    creatingRef.current = true;
    (async () => {
      try {
        const trip = await api.createTrip({
          anchor: {
            eventId: data.eventId,
            ticketTier: data.selection[0]?.tierId ?? "GA",
            quantity: totalTickets || 1,
          },
        });
        setTripId(trip.id);
      } catch {
        // Backend unavailable — fall back to a demo id so the UI still flows.
        setTripId(`demo_${Math.random().toString(36).slice(2, 10)}`);
      }
    })();
  }, [step, tripId, data, totalTickets]);

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 pt-6 md:px-6">
        <div className="mb-4 flex items-center gap-2">
          {step > 0 && step < 3 ? (
            <button
              onClick={() => go(step - 1)}
              className="flex items-center gap-1 text-sm font-medium text-ink-secondary hover:text-ink-primary"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
          ) : (
            <Link
              href={`/events/${data.eventId}`}
              className="flex items-center gap-1 text-sm font-medium text-ink-secondary hover:text-ink-primary"
            >
              <ChevronLeft className="h-4 w-4" /> Event
            </Link>
          )}
        </div>

        <StepIndicator steps={STEPS} current={step} />

        <div className="relative mt-8 overflow-hidden">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={{ opacity: 0, x: direction * 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -60 }}
              transition={{ duration: 0.3 }}
            >
              {/* ── STEP 1: Order Summary ── */}
              {step === 0 && (
                <div>
                  <h2 className="text-xl font-bold text-ink-primary">
                    Order Summary
                  </h2>
                  <div className="mt-4 rounded-lg bg-white p-5 card-shadow">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-bold text-ink-primary">
                          {data.eventTitle}
                        </p>
                        <p className="text-sm text-ink-secondary">
                          {data.date} · {data.venue}
                        </p>
                      </div>
                      <Link
                        href={`/events/${data.eventId}`}
                        className="text-sm font-semibold text-primary"
                      >
                        Edit
                      </Link>
                    </div>

                    <div className="my-4 h-px bg-gray-100" />

                    {data.selection.map((line) => (
                      <div
                        key={line.tierId}
                        className="flex justify-between py-1 text-sm"
                      >
                        <span className="text-ink-secondary">
                          {line.qty}× {line.name} @ {formatMoney(line.price)}
                        </span>
                        <span className="font-medium text-ink-primary">
                          {formatMoney({
                            amount: line.price.amount * line.qty,
                            currency,
                          })}
                        </span>
                      </div>
                    ))}

                    {promoApplied && (
                      <div className="flex justify-between py-1 text-sm">
                        <span className="font-medium text-green-700">
                          Promo {data.promo} applied
                        </span>
                        <span className="font-medium text-green-700">
                          −{formatMoney(discount)}
                        </span>
                      </div>
                    )}

                    <div className="flex justify-between py-1 text-sm">
                      <span className="text-ink-secondary">Service fee</span>
                      <span className="font-medium text-ink-primary">
                        {formatMoney(fee)}
                      </span>
                    </div>

                    <div className="my-3 h-px bg-gray-100" />

                    <div className="flex justify-between">
                      <span className="font-bold text-ink-primary">Total</span>
                      <span className="text-lg font-extrabold text-ink-primary">
                        {formatMoney(total)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => go(1)}
                    className="mt-6 w-full rounded-md bg-primary py-3.5 font-semibold text-white transition-colors hover:bg-primary-600"
                  >
                    Continue to Details
                  </button>
                </div>
              )}

              {/* ── STEP 2: Your Details ── */}
              {step === 1 && (
                <form onSubmit={handleSubmit(() => go(2))}>
                  <h2 className="text-xl font-bold text-ink-primary">
                    Your Details
                  </h2>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <Field
                      label="First Name"
                      error={errors.firstName?.message}
                      {...register("firstName", { required: "Required" })}
                    />
                    <Field
                      label="Last Name"
                      error={errors.lastName?.message}
                      {...register("lastName", { required: "Required" })}
                    />
                  </div>
                  <div className="mt-3">
                    <Field
                      label="Email"
                      type="email"
                      error={errors.email?.message}
                      {...register("email", {
                        required: "Required",
                        pattern: {
                          value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
                          message: "Enter a valid email",
                        },
                      })}
                    />
                  </div>
                  <div className="mt-3">
                    <label className="mb-1 block text-sm font-medium text-ink-primary">
                      Phone
                    </label>
                    <div className="flex gap-2">
                      <span className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-3 text-sm">
                        🇺🇸 +1
                      </span>
                      <input
                        placeholder="(555) 000-0000"
                        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-primary"
                        {...register("phone", { required: "Required" })}
                      />
                    </div>
                    {errors.phone && (
                      <p className="mt-1 text-xs text-red-600">
                        {errors.phone.message}
                      </p>
                    )}
                  </div>

                  <label className="mt-4 flex items-start gap-2 text-sm text-ink-secondary">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-primary"
                      {...register("isHolder")}
                    />
                    I am the ticket holder / details match ID at entry
                  </label>

                  <button
                    type="submit"
                    className="mt-6 w-full rounded-md bg-primary py-3.5 font-semibold text-white transition-colors hover:bg-primary-600"
                  >
                    Continue to Payment
                  </button>
                </form>
              )}

              {/* ── STEP 3: Payment ── */}
              {step === 2 && (
                <div>
                  <h2 className="text-xl font-bold text-ink-primary">Payment</h2>
                  <div className="mt-4 rounded-lg bg-white p-5 card-shadow">
                    {!tripId ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-secondary">
                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                        Preparing your order…
                      </div>
                    ) : (
                      <StripePaymentStep
                        tripId={tripId}
                        amount={total}
                        promoSaved={promoApplied ? discount : null}
                        onPaid={(pi) => {
                          setPaymentIntentId(pi);
                          go(3);
                        }}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* ── STEP 4: Confirmation ── */}
              {step === 3 && tripId && (
                <div className="rounded-lg bg-white p-6 card-shadow">
                  <BookingProgress
                    tripId={tripId}
                    paymentIntentId={paymentIntentId}
                    eventTitle={data.eventTitle}
                    total={total}
                    onRetry={() => go(2)}
                  />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {step < 3 && (
          <p className="mt-6 text-center text-xs text-ink-secondary">
            {totalTickets} ticket{totalTickets > 1 ? "s" : ""} ·{" "}
            {formatMoney(total)} total
          </p>
        )}
      </div>
    </AppShell>
  );
}

// ── Reusable form field (forwards RHF register props) ──
interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, ...props },
  ref,
) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink-primary">
        {label}
      </label>
      <input
        ref={ref}
        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-primary"
        {...props}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
});