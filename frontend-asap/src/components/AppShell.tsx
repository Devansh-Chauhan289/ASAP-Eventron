import { Navbar } from "./Navbar";
import { BottomNav } from "./BottomNav";

/**
 * Wraps the in-app pages with the desktop Navbar and the mobile BottomNav.
 * Adds bottom padding on mobile so content clears the floating nav.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <Navbar />
      <main className="pb-24 md:pb-0">{children}</main>
      <BottomNav />
    </div>
  );
}