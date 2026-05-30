"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Mail, Lock, Sparkles } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/home";
  const [loading, setLoading] = useState(false);

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // Demo auth: set a readable cookie the middleware will accept.
    // In production the access token is an httpOnly cookie set by the API.
    document.cookie = `asap_access=demo; path=/; max-age=86400; samesite=lax`;
    router.push(next);
  };

  return (
    <form
      onSubmit={handleSignIn}
      className="w-full max-w-sm rounded-lg bg-white p-8 card-shadow"
    >
      <Link href="/" className="mb-6 flex items-center justify-center gap-1">
        <span className="text-2xl font-extrabold text-primary">ASAP</span>
        <span className="text-2xl font-extrabold text-ink-primary">Eventron</span>
      </Link>

      <h1 className="text-center text-xl font-bold text-ink-primary">
        Welcome back
      </h1>
      <p className="mt-1 text-center text-sm text-ink-secondary">
        Sign in to plan events and book travel.
      </p>

      <div className="mt-6 space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5">
          <Mail className="h-4 w-4 text-ink-secondary" />
          <input
            type="email"
            defaultValue="jordan@example.com"
            className="w-full text-sm outline-none"
            placeholder="Email"
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5">
          <Lock className="h-4 w-4 text-ink-secondary" />
          <input
            type="password"
            defaultValue="password"
            className="w-full text-sm outline-none"
            placeholder="Password"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="mt-6 w-full rounded-md bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-60"
      >
        {loading ? "Signing in…" : "Sign In"}
      </button>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-secondary">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        Demo mode — any credentials work
      </p>
    </form>
  );
}

export default function LoginPage() {
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
          <LoginForm />
        </Suspense>
      </motion.div>
    </div>
  );
}