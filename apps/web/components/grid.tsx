"use client";

import {
  AllCommunityModule,
  colorSchemeVariable,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import { forwardRef, useEffect, useState } from "react";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid reads light/dark from data-ag-theme-mode on an ancestor; mirror the app's .dark class.
const theme = themeQuartz.withPart(colorSchemeVariable).withParams({
  fontFamily: "inherit",
  headerFontWeight: 600,
  borderRadius: 10,
  wrapperBorderRadius: 14,
  accentColor: "oklch(0.55 0.19 262)",
});

function useThemeMode() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  useEffect(() => {
    const read = () =>
      setMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return mode;
}

export const Grid = forwardRef<AgGridReact, AgGridReactProps & { height?: number | string }>(
  function Grid({ height = 520, ...props }, ref) {
    const mode = useThemeMode();
    return (
      <div data-ag-theme-mode={mode} style={{ height, width: "100%" }}>
        <AgGridReact ref={ref} theme={theme} animateRows {...props} />
      </div>
    );
  },
);
