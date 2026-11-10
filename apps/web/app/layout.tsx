import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { Dock } from "@/components/shell/Dock";
import { MonitorStrip } from "@/components/shell/MonitorStrip";
import { MotionRoot } from "@/components/shell/Motion";
import { Stage } from "@/components/stage/Stage";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "ProofOfIntent -- Semantic Checkout Firewall",
  description:
    "Signed mandates prove you said yes. ProofOfIntent proves the agent bought what you meant.",
};

export const viewport: Viewport = { themeColor: "#03050a" };

/**
 * The firewall behind everything (it lives here, so it keeps running across page changes), a status strip on
 * top, a floating dock at the bottom, and the page scrolling on the window so the scene can follow it.
 * `isolate` makes this the stacking context, so the scene (negative z) paints above the body background.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="min-h-screen font-sans text-ink antialiased">
        <MotionRoot>
          <div className="relative isolate min-h-screen w-full">
            <Stage />
            <MonitorStrip />
            <main className="mx-auto w-full max-w-[1400px] px-4 pb-36 pt-6 sm:px-8">
              {children}
            </main>
            <footer
              data-print="hidden"
              className="mx-auto max-w-[1400px] px-4 pb-28 font-mono text-[11px] tracking-[0.14em] text-faint sm:px-8"
            >
              PAYPAL SANDBOX ONLY · THE BAZAAR IS SYNTHETIC AND ITS ATTACKS WERE WRITTEN BY THE TEAM
            </footer>
            <Dock />
          </div>
        </MotionRoot>
      </body>
    </html>
  );
}
