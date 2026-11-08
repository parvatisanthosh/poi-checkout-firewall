"use client";

import type { ColDef, ColGroupDef, ICellRendererParams } from "ag-grid-community";
import type { AgGridReact } from "ag-grid-react";
import { useMemo, useRef, useState } from "react";
import type { BenchConfigId, BenchRow, BenchSummary, Rate } from "@poi/shared";
import { Grid } from "@/components/grid";
import { Button } from "@/components/ui";

interface Row {
  model: string;
  family: string;
  purchases: number;
  undefended: Rate;
  deterministic: Rate;
  semantic: Rate;
  terms: Rate;
  full: Rate;
  askHuman: Rate;
  falseVoid: Rate | null;
  latency: number | null;
}

const CONFIGS: BenchConfigId[] = ["deterministic", "semantic", "terms", "full"];
const LABEL: Record<BenchConfigId, string> = {
  deterministic: "Rules",
  semantic: "+ Judge",
  terms: "+ Terms",
  full: "Full POI",
};

/** Inline bar + "k/n" + CI tooltip, red (bad) to green (good). `goodLow` = lower is better. */
function RateCell({ value, goodLow = true }: { value?: Rate | null; goodLow?: boolean }) {
  if (!value || value.n === 0 || value.p === null) return <span className="text-muted">--</span>;
  const p = value.p;
  const badness = goodLow ? p : 1 - p;
  const hue = Math.round(145 - badness * 120);
  const ci = `${Math.round((value.lo ?? 0) * 100)}-${Math.round((value.hi ?? 0) * 100)}% (Wilson 95%)`;
  return (
    <div
      className="flex h-full items-center gap-2"
      title={`${value.k}/${value.n} = ${Math.round(p * 100)}%, CI ${ci}`}
    >
      <div className="h-2 w-16 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(3, p * 100)}%`, background: `oklch(0.62 0.16 ${hue})` }}
        />
      </div>
      <span className="font-mono text-xs">
        {Math.round(p * 100)}%{" "}
        <span className="text-muted">
          {value.k}/{value.n}
        </span>
      </span>
    </div>
  );
}

function toRows(rows: BenchRow[]): Row[] {
  const keyed = new Map<string, Row>();
  for (const r of rows) {
    const key = `${r.model}|${r.family}`;
    const row =
      keyed.get(key) ??
      ({
        model: r.model,
        family: r.family,
        purchases: r.purchases,
        undefended: r.undefendedAsr,
        askHuman: r.askHumanRate,
        falseVoid: r.falseVoidRate,
        latency: r.medianVerifyLatencyMs,
      } as Row);
    row[r.config] = r.defendedAsr;
    if (r.config === "full") {
      row.undefended = r.undefendedAsr;
      row.askHuman = r.askHumanRate;
      row.falseVoid = r.falseVoidRate;
      row.latency = r.medianVerifyLatencyMs;
      row.purchases = r.purchases;
    }
    keyed.set(key, row);
  }
  return [...keyed.values()];
}

export function Scorecard({ summary }: { summary: BenchSummary }) {
  const grid = useRef<AgGridReact>(null);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => toRows(summary.rows), [summary]);
  const totals = useMemo(
    () => toRows(summary.totals.filter((t) => t.family === "all-attacks")),
    [summary],
  );
  const rate = (field: keyof Row, goodLow = true): Partial<ColDef<Row>> => ({
    field,
    cellRenderer: (p: ICellRendererParams<Row>) => (
      <RateCell value={p.value as Rate} goodLow={goodLow} />
    ),
    comparator: (a?: Rate, b?: Rate) => (a?.p ?? -1) - (b?.p ?? -1),
    minWidth: 150,
    tooltipValueGetter: (p) => {
      const v = p.value as Rate | null;
      return v && v.p !== null
        ? `${v.k}/${v.n}, 95% CI ${Math.round((v.lo ?? 0) * 100)}-${Math.round((v.hi ?? 0) * 100)}%`
        : "";
    },
  });
  const columns: Array<ColDef<Row> | ColGroupDef<Row>> = [
    { field: "model", pinned: "left", minWidth: 190 },
    { field: "family", minWidth: 120 },
    { field: "purchases", headerName: "Buys", width: 90 },
    {
      headerName: "Undefended",
      children: [{ ...rate("undefended"), headerName: "Attack success" }],
    },
    {
      headerName: "Defended (ablations): attacks that still got paid",
      children: CONFIGS.map((c) => ({ ...rate(c), headerName: LABEL[c] })),
    },
    {
      headerName: "Utility (full POI)",
      children: [
        { ...rate("askHuman"), headerName: "Asked a human" },
        { ...rate("falseVoid"), headerName: "False void (benign)" },
        {
          field: "latency",
          headerName: "Median verify",
          valueFormatter: (p) => (p.value ? `${(Number(p.value) / 1000).toFixed(1)} s` : "--"),
          width: 130,
        },
      ],
    },
  ];
  const t = summary.totals;
  const und = t.find((x) => x.family === "all-attacks" && x.config === "full")?.undefendedAsr;
  const full = t.find((x) => x.family === "all-attacks" && x.config === "full")?.defendedAsr;
  const fv = t.find((x) => x.family === "benign" && x.config === "full")?.falseVoidRate;
  const pct = (r?: Rate | null) => (r && r.p !== null ? `${Math.round(r.p * 100)}%` : "--");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Attacks that got paid, no POI", pct(und), und ? `${und.k}/${und.n} purchases` : ""],
          ["... with full POI", pct(full), full ? `${full.k}/${full.n} purchases` : ""],
          ["Good purchases wrongly voided", pct(fv), fv ? `${fv.k}/${fv.n} benign` : ""],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-2xl border border-line bg-white p-4 dark:bg-zinc-900">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 text-3xl font-black tracking-tight">{value}</p>
            <p className="text-xs text-muted">{sub}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="w-64 rounded-xl border border-line bg-white px-3 py-1.5 text-sm dark:bg-zinc-900"
          placeholder="Filter rows (model, family…)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button
          variant="ghost"
          onClick={() =>
            grid.current?.api.exportDataAsCsv({
              fileName: "poi-scorecard.csv",
              processCellCallback: (p) => {
                const v = p.value as Rate | null;
                return v && typeof v === "object" && "k" in v
                  ? `${v.k}/${v.n}`
                  : String(p.value ?? "");
              },
            })
          }
        >
          Export CSV
        </Button>
        <span className="text-xs text-muted">
          Batches: {summary.batches.join(", ")} · {summary.note}
        </span>
      </div>
      <Grid
        ref={grid}
        rowData={rows}
        columnDefs={columns}
        pinnedBottomRowData={totals.map((r) => ({
          ...r,
          model: "All models",
          family: "all attacks",
        }))}
        quickFilterText={filter}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        tooltipShowDelay={200}
        height={560}
      />
    </div>
  );
}
