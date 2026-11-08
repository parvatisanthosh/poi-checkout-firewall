import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProofOfIntent -- Semantic Checkout Firewall",
  description:
    "Signed mandates prove you said yes. ProofOfIntent proves the agent bought what you meant.",
};

const NAV = [
  ["/shop", "Live demo"],
  ["/bazaar", "Bazaar"],
  ["/bench", "Scorecard"],
  ["/ledger", "Ledger"],
] as const;

// Runs before paint so there's no light/dark flash.
const THEME_SCRIPT = `try{var t=localStorage.getItem("poi-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <header className="sticky top-0 z-20 border-b border-line bg-panel/85 backdrop-blur">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-xs font-bold text-white">
                PoI
              </span>
              ProofOfIntent
            </Link>
            <div className="flex flex-1 items-center gap-4 overflow-x-auto text-sm text-muted">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="whitespace-nowrap hover:text-ink">
                  {label}
                </Link>
              ))}
            </div>
            <ThemeToggle />
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
          PayPal sandbox only. The Bazaar is synthetic and its attacks were written by the team.
        </footer>
      </body>
    </html>
  );
}
