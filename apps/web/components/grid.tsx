"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import { forwardRef } from "react";

ModuleRegistry.registerModules([AllCommunityModule]);

// Cold storage: the grid is a dark glass slab with ice hairlines, like every other panel.
const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  headerFontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  headerFontSize: 11,
  headerFontWeight: 500,
  headerTextColor: "rgba(155, 231, 255, 0.75)",
  headerBackgroundColor: "rgba(7, 13, 22, 0.96)",
  backgroundColor: "rgba(5, 10, 17, 0.92)",
  oddRowBackgroundColor: "rgba(10, 19, 30, 0.6)",
  foregroundColor: "#e6f6ff",
  borderColor: "rgba(155, 231, 255, 0.1)",
  rowHoverColor: "rgba(155, 231, 255, 0.06)",
  selectedRowBackgroundColor: "rgba(155, 231, 255, 0.1)",
  accentColor: "#9be7ff",
  chromeBackgroundColor: "rgba(7, 13, 22, 0.96)",
  borderRadius: 10,
  wrapperBorderRadius: 16,
  rowHeight: 46,
  headerHeight: 42,
  spacing: 7,
});

export const Grid = forwardRef<AgGridReact, AgGridReactProps & { height?: number | string }>(
  function Grid({ height = 520, ...props }, ref) {
    return (
      <div
        data-ag-theme-mode="dark"
        className="overflow-hidden rounded-2xl shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
        style={{ height, width: "100%" }}
      >
        <AgGridReact ref={ref} theme={theme} animateRows {...props} />
      </div>
    );
  },
);
