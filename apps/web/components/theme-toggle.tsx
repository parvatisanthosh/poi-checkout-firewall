"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("poi-theme", next ? "dark" : "light");
    } catch {
      // storage blocked: the toggle still works for this page view
    }
  };
  return (
    <button
      onClick={toggle}
      className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:text-ink"
      aria-label="Toggle dark mode"
    >
      {dark ? "Light" : "Dark"}
    </button>
  );
}
