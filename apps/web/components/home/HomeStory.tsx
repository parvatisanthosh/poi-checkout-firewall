"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { haltNow, setStage } from "@/components/stage/store";
import { cx } from "@/components/ui";

const EASE = [0.22, 1, 0.36, 1] as const;
const STEPS = 6;

/** Tells the 3D stage which story step is on screen; the VOID step fires the shock once per arrival. */
function useStoryStep(refs: React.RefObject<Array<HTMLElement | null>>) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const els = (refs.current ?? []).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = Number((e.target as HTMLElement).dataset.step);
          setStep(n);
        }
      },
      { threshold: 0.55 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [refs]);
  useEffect(() => {
    setStage({ story: step });
    if (step !== 4) return;
    const t = setTimeout(haltNow, 650); // once the order has entered the gate
    return () => clearTimeout(t);
  }, [step]);
  return step;
}

function Beat({
  index,
  setRef,
  eyebrow,
  title,
  tone = "ice",
  children,
}: {
  index: number;
  setRef: (i: number, el: HTMLElement | null) => void;
  eyebrow: string;
  title: ReactNode;
  tone?: "ice" | "danger";
  children: ReactNode;
}) {
  return (
    <section
      ref={(el) => setRef(index, el)}
      data-step={index}
      className="flex min-h-[100svh] items-end pb-40 sm:items-center sm:pb-0"
    >
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ amount: 0.5 }}
        transition={{ duration: 0.9, ease: EASE }}
        className="max-w-xl rounded-2xl border border-ice/10 bg-canvas/75 p-5 backdrop-blur-sm sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none"
      >
        <p className="eyebrow">
          {String(index).padStart(2, "0")} · {eyebrow}
        </p>
        <h2
          className={cx(
            "display mt-5 text-5xl sm:text-7xl",
            tone === "danger" ? "danger-text" : "ice-text",
          )}
        >
          {title}
        </h2>
        <div className="mt-6 max-w-md text-base leading-relaxed text-muted sm:text-lg">
          {children}
        </div>
      </motion.div>
    </section>
  );
}

export function HomeStory({ children }: { children: ReactNode }) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const setRef = (i: number, el: HTMLElement | null) => {
    refs.current[i] = el;
  };
  const step = useStoryStep(refs);

  return (
    <div className="-mt-6">
      {/* step counter, like a reel */}
      <div
        aria-hidden
        className="pointer-events-none fixed bottom-24 left-5 z-20 hidden font-mono text-[11px] tracking-[0.3em] text-faint sm:block"
      >
        <span className="text-ice">{String(step + 1).padStart(2, "0")}</span> /{" "}
        {String(STEPS).padStart(2, "0")}
      </div>

      <section
        ref={(el) => setRef(0, el)}
        data-step={0}
        className="relative flex min-h-[calc(100svh-44px)] flex-col justify-center pb-24"
      >
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="eyebrow"
        >
          Semantic checkout firewall · AI agents · PayPal
        </motion.p>
        <motion.h1
          initial={{ opacity: 0, y: 30, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 1.2, ease: EASE, delay: 0.3 }}
          className="display ice-text mt-6 text-[clamp(64px,12vw,184px)] uppercase"
        >
          Proof
          <br />
          of intent
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: EASE, delay: 0.7 }}
          className="mt-8 max-w-lg text-lg leading-relaxed text-muted"
        >
          Signed mandates prove you said yes. POI proves the agent bought what you{" "}
          <span className="text-ink">meant</span> -- before any money moves.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: EASE, delay: 0.9 }}
          className="mt-10 flex flex-wrap gap-3"
        >
          <Link href="/shop" className="pill-cta pill-primary">
            Try the live demo <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/bazaar" className="pill-cta pill-ghost">
            See the poisoned store
          </Link>
        </motion.div>
        <div className="absolute inset-x-0 bottom-28 flex justify-center sm:bottom-10">
          <span className="motion-safe-only flex animate-bob flex-col items-center gap-1 font-mono text-[11px] tracking-[0.3em] text-faint">
            SCROLL <ChevronDown className="h-4 w-4" />
          </span>
        </div>
      </section>

      <Beat index={1} setRef={setRef} eyebrow="The agent shops" title="Your agent found it.">
        You asked for a USB-C hub: under $40, one-time, new only -- and signed it. The agent browsed
        a store, picked a listing, and PayPal holds the payment.
      </Beat>
      <Beat index={2} setRef={setRef} eyebrow="The order" title="It isn't what you meant.">
        A <span className="text-ask">$6.99/month membership</span> hidden in the line items. A note
        to AI assistants in the page. The signature is valid -- on the wrong order. The halves pull
        apart where they disagree.
      </Beat>
      <Beat index={3} setRef={setRef} eyebrow="The firewall" title="POI re-reads the real order.">
        Straight from PayPal, line by line, against what you signed: hard rules in integer cents,
        the merchant&apos;s fine print, a spotlighted judge, and a shadow re-run of the shopping.
      </Beat>
      <Beat index={4} setRef={setRef} eyebrow="The verdict" title="Then it stops." tone="danger">
        <span className="text-void">VOID.</span> The hold is released -- no money moves -- and a
        signed, hash-chained record says exactly why. Anyone can check it.
      </Beat>

      <section ref={(el) => setRef(5, el)} data-step={5} className="pt-24">
        {children}
      </section>
    </div>
  );
}
