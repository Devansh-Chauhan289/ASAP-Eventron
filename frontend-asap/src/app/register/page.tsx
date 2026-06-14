"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Mail, Lock, User, AlertCircle } from "lucide-react";
import { auth, ApiClientError } from "@/lib/api";

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/home";
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      await auth.register({ email, password, displayName });
      router.push(next);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not create your account. Please try again.",
      );
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleRegister}
      className="w-full max-w-sm rounded-lg bg-white p-8 card-shadow"
    >
      <Link href="/" className="mb-6 flex items-center justify-center gap-1">
        <span className="text-2xl font-extrabold text-primary">ASAP</span>
        <span className="text-2xl font-extrabold text-ink-primary">Eventron</span>
      </Link>

      <h1 className="text-center text-xl font-bold text-ink-primary">
        Create your account
      </h1>
      <p className="mt-1 text-center text-sm text-ink-secondary">
        Plan events, book travel, manage the whole trip in one place.
      </p>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-6 space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5">
          <User className="h-4 w-4 text-ink-secondary" />
          <input
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full text-sm outline-none"
            placeholder="Full name"
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5">
          <Mail className="h-4 w-4 text-ink-secondary" />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full text-sm outline-none"
            placeholder="Email"
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5">
          <Lock className="h-4 w-4 text-ink-secondary" />
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full text-sm outline-none"
            placeholder="Password (min 8 characters)"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="mt-6 w-full rounded-md bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-60"
      >
        {loading ? "Creating account…" : "Create Account"}
      </button>

      <p className="mt-4 text-center text-sm text-ink-secondary">
        Already have an account?{" "}
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="font-semibold text-primary hover:underline"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg-dark p-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-20 top-10 h-72 w-72 animate-float rounded-full bg-primary/40 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-80 w-80 animate-float-slow rounded-full bg-tag-recommended/30 blur-3xl" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-sm"
      >
        <Suspense fallback={null}>
          <RegisterForm />
        </Suspense>
      </motion.div>
    </div>
  );
}
