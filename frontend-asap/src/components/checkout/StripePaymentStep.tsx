"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Lock, ShieldCheck, CreditCard, Loader2 } from "lucide-react";
import { getStripe } from "@/lib/stripe";
import { api, ApiClientError } from "@/lib/api";
import type { Money } from "@/lib/types";
import { formatMoney } from "@/lib/money";

interface StripePaymentStepProps {
  tripId: string;
  amount: Money;
  promoSaved?: Money | null;
  onPaid: () => void;
}

// ── Inner form rendered once Stripe Elements is mounted ──
function CardForm({
  amount,
  onPaid,
}: {
  amount: Money;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    // Stripe renders/validates the card fields — we never touch raw PAN/CVV.
    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message ?? "Payment failed. Please try again.");
      setSubmitting(false);
      return;
    }
    // On success the caller triggers POST /trips/{id}/confirm.
    onPaid();
  };

  return (
    <div>
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <PayButton submitting={submitting} amount={amount} onClick={handlePay} />
    </div>
  );
}

function PayButton({
  submitting,
  amount,
  onClick,
}: {
  submitting: boolean;
  amount: Money;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={submitting}
      className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-[#635BFF] px-6 py-3.5 font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
    >
      {submitting ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <Lock className="h-5 w-5" />
      )}
      Pay {formatMoney(amount)} Securely
    </button>
  );
}

function SecurityBadges() {
  return (
    <div className="mt-4 flex items-center justify-center gap-4 text-xs text-ink-secondary">
      <span className="flex items-center gap-1">
        <Lock className="h-3.5 w-3.5" /> 256-bit SSL
      </span>
      <span className="flex items-center gap-1">
        <ShieldCheck className="h-3.5 w-3.5" /> PCI DSS Compliant
      </span>
      <span className="flex items-center gap-1">
        Powered by <strong className="text-[#635BFF]">stripe</strong>
      </span>
    </div>
  );
}

// ── Demo fallback when no Stripe key / backend is configured ──
function DemoCardForm({
  amount,
  onPaid,
}: {
  amount: Money;
  onPaid: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handlePay = () => {
    setSubmitting(true);
    // Simulate Stripe confirmPayment latency, then proceed.
    setTimeout(onPaid, 1400);
  };

  return (
    <div>
      <div className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-ink-secondary">
        <p className="mb-3 flex items-center gap-2 font-medium text-ink-primary">
          <CreditCard className="h-4 w-4" /> Demo card fields
        </p>
        <p>
          In production these are rendered by{" "}
          <strong>Stripe Elements</strong> (card number, expiry, CVV) — your
          code never touches raw card data. Configure{" "}
          <code className="rounded bg-white px-1">NEXT_PUBLIC_STRIPE_KEY</code>{" "}
          and a live <code className="rounded bg-white px-1">clientSecret</code>{" "}
          to mount the real form.
        </p>
      </div>
      <PayButton submitting={submitting} amount={amount} onClick={handlePay} />
    </div>
  );
}

export function StripePaymentStep({
  tripId,
  amount,
  promoSaved,
  onPaid,
}: StripePaymentStepProps) {
  const [method, setMethod] = useState<"card" | "apple" | "google">("card");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeReady, setStripeReady] = useState<boolean | null>(null);
  const [useSavedCard, setUseSavedCard] = useState(true);
  const [saveCard, setSaveCard] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [promoRemoved, setPromoRemoved] = useState(false);

  const stripePromise = useMemo(() => getStripe(), []);

  // POST /trips/{id}/checkout → clientSecret, then mount Elements.
  useEffect(() => {
    let active = true;
    (async () => {
      const stripe = await stripePromise;
      if (!active) return;
      if (!stripe) {
        setStripeReady(false); // demo mode
        return;
      }
      try {
        const { clientSecret } = await api.checkout(tripId);
        if (active) {
          setClientSecret(clientSecret);
          setStripeReady(true);
        }
      } catch (err) {
        if (err instanceof ApiClientError) {
          // Backend unavailable — gracefully degrade to demo mode.
          setStripeReady(false);
        } else {
          setStripeReady(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [stripePromise, tripId]);

  const canPay = agreed;

  return (
    <div>
      {/* Method toggle */}
      <div className="grid grid-cols-3 gap-2">
        {(["card", "apple", "google"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            className={`rounded-md border py-2.5 text-sm font-semibold capitalize transition-colors ${
              method === m
                ? "border-primary bg-primary-50 text-primary"
                : "border-gray-200 bg-white text-ink-secondary"
            }`}
          >
            {m === "card" ? "Card" : m === "apple" ? "Apple Pay" : "Google Pay"}
          </button>
        ))}
      </div>

      {method !== "card" ? (
        <div className="mt-5 rounded-md bg-gray-50 p-6 text-center text-sm text-ink-secondary">
          {method === "apple" ? "Apple Pay" : "Google Pay"} sheet opens on
          supported devices.
          <button
            onClick={onPaid}
            className="mt-4 w-full rounded-md bg-ink-primary py-3 font-semibold text-white"
          >
            Continue with {method === "apple" ? "Apple Pay" : "Google Pay"}
          </button>
        </div>
      ) : (
        <div className="mt-5">
          {/* Saved card */}
          <label className="mb-4 flex cursor-pointer items-center justify-between rounded-md border border-gray-200 bg-white p-3">
            <span className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-ink-secondary" />
              <span className="text-sm font-medium text-ink-primary">
                Visa ending in 4242
              </span>
            </span>
            <input
              type="radio"
              checked={useSavedCard}
              onChange={() => setUseSavedCard(true)}
              className="h-4 w-4 accent-primary"
            />
          </label>

          <button
            onClick={() => setUseSavedCard(false)}
            className={`mb-4 text-sm font-medium ${
              useSavedCard ? "text-primary" : "text-ink-secondary"
            }`}
          >
            + Use a different card
          </button>

          {/* Stripe Elements / demo */}
          {!useSavedCard && stripeReady === null && (
            <div className="flex items-center gap-2 py-6 text-sm text-ink-secondary">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading secure
              payment form…
            </div>
          )}

          {!useSavedCard &&
            stripeReady === true &&
            clientSecret &&
            stripePromise && (
              <Elements
                stripe={stripePromise}
                options={{ clientSecret, appearance: { theme: "stripe" } }}
              >
                <CardForm amount={amount} onPaid={onPaid} />
              </Elements>
            )}

          {!useSavedCard && stripeReady === false && (
            <DemoCardForm amount={amount} onPaid={onPaid} />
          )}

          {/* Save card */}
          {!useSavedCard && (
            <label className="mt-4 flex items-center gap-2 text-sm text-ink-secondary">
              <input
                type="checkbox"
                checked={saveCard}
                onChange={(e) => setSaveCard(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Save card for next time
            </label>
          )}
        </div>
      )}

      {/* Promo applied */}
      {promoSaved && !promoRemoved && (
        <div className="mt-4 flex items-center justify-between rounded-md bg-green-50 px-4 py-3 text-sm">
          <span className="font-medium text-green-700">
            NEON10 applied — You saved {formatMoney(promoSaved)}
          </span>
          <button
            onClick={() => setPromoRemoved(true)}
            className="text-xs font-semibold text-green-700 underline"
          >
            Remove
          </button>
        </div>
      )}

      {/* Terms */}
      <label className="mt-4 flex items-start gap-2 text-sm text-ink-secondary">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        I agree to the Terms of Service and Refund Policy.
      </label>

      {/* Pay button for the saved card path. The Elements / demo forms render
          their own button; wallet methods use their own continue button. */}
      {method === "card" && useSavedCard && (
        <button
          onClick={onPaid}
          disabled={!canPay}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-[#635BFF] px-6 py-3.5 font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-50"
        >
          <Lock className="h-5 w-5" />
          Pay {formatMoney(amount)} Securely
        </button>
      )}

      <SecurityBadges />
    </div>
  );
}