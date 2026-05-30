import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-6 text-center">
      <p className="text-6xl font-extrabold text-primary">404</p>
      <h1 className="mt-4 text-2xl font-bold text-ink-primary">
        We couldn&apos;t find that page
      </h1>
      <p className="mt-2 max-w-sm text-ink-secondary">
        The event or page you&apos;re looking for may have moved or sold out.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/"
          className="rounded-md border border-gray-200 bg-white px-5 py-2.5 text-sm font-semibold text-ink-primary hover:bg-gray-50"
        >
          Go home
        </Link>
        <Link
          href="/events"
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-600"
        >
          Browse events
        </Link>
      </div>
    </div>
  );
}