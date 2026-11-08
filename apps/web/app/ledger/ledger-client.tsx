"use client";

import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  EVENTS,
  formatMoney,
  LIVE_NAMESPACE,
  type ClientToServerEvents,
  type LedgerRow,
  type ServerToClientEvents,
} from "@poi/shared";
import { Grid } from "@/components/grid";
import { Button, ErrorNote, Pill, VerdictBadge } from "@/components/ui";
import { POI_API_URL, poi } from "@/lib/config";

const SETTLEMENT_TONE = {
  CAPTURED: "good",
  VOIDED: "bad",
  PENDING_HUMAN: "warn",
  NONE: "neutral",
} as const;

export function LedgerClient() {
  const router = useRouter();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [mode, setMode] = useState<"" | "live" | "dry-run">("");
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  const load = useCallback(
    async (after?: string) => {
      try {
        const page = await poi.getLedger({
          limit: 50,
          ...(after ? { cursor: after } : {}),
          ...(mode ? { mode } : {}),
        });
        setRows((prev) => (after ? [...prev, ...page.rows] : page.rows));
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        setError(`Couldn't load the ledger from ${POI_API_URL}: ${(err as Error).message}`);
      }
    },
    [mode],
  );

  useEffect(() => void load(), [load]);

  // Live updates: watch every unsettled row's room; refresh when one settles.
  useEffect(() => {
    const s: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      `${POI_API_URL}${LIVE_NAMESPACE}`,
      { transports: ["websocket", "polling"] },
    );
    socket.current = s;
    s.on(EVENTS.orderSettled, () => void load());
    s.on(EVENTS.verifyVerdict, () => void load());
    return () => {
      s.close();
    };
  }, [load]);
  useEffect(() => {
    for (const r of rows)
      if (r.settlement === "NONE" || r.settlement === "PENDING_HUMAN" || !r.verdict)
        socket.current?.emit(EVENTS.subscribe, { orderId: r.orderId });
  }, [rows]);

  const columns: Array<ColDef<LedgerRow>> = [
    {
      field: "createdAt",
      headerName: "When",
      valueFormatter: (p) => new Date(String(p.value)).toLocaleString(),
      minWidth: 170,
      sort: "desc",
    },
    {
      field: "verdict",
      cellRenderer: (p: ICellRendererParams<LedgerRow>) => (
        <VerdictBadge verdict={p.data?.verdict} />
      ),
      width: 130,
    },
    {
      field: "settlement",
      cellRenderer: (p: ICellRendererParams<LedgerRow>) => (
        <Pill tone={SETTLEMENT_TONE[p.data?.settlement ?? "NONE"]}>
          {p.data?.settlement.replace("_", " ").toLowerCase()}
        </Pill>
      ),
      width: 140,
    },
    { field: "merchantDisplayName", headerName: "Merchant", minWidth: 150 },
    {
      field: "total",
      valueFormatter: (p) => (p.data ? formatMoney(p.data.total) : ""),
      width: 110,
      comparator: (a, b) => Number(a?.value ?? 0) - Number(b?.value ?? 0),
    },
    {
      field: "topReason",
      headerName: "Top reason",
      flex: 2,
      minWidth: 260,
      tooltipField: "topReason",
    },
    { field: "mode", width: 100 },
    { field: "model", minWidth: 170 },
    { field: "runTag", headerName: "Run tag", minWidth: 140 },
    { field: "orderId", headerName: "PayPal order", minWidth: 170, cellClass: "font-mono text-xs" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm dark:bg-zinc-900"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="">All modes</option>
          <option value="live">Live</option>
          <option value="dry-run">Dry run</option>
        </select>
        <Button variant="ghost" onClick={() => void load()}>
          Refresh
        </Button>
        <span className="text-xs text-muted">
          {rows.length} orders · click a row for its evidence
        </span>
      </div>
      <ErrorNote error={error} />
      <Grid
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        getRowId={(p) => p.data.orderId}
        onRowClicked={(e: RowClickedEvent<LedgerRow>) =>
          e.data && router.push(`/verify/${encodeURIComponent(e.data.orderId)}`)
        }
        rowClass="cursor-pointer"
        tooltipShowDelay={300}
        height={600}
      />
      {cursor && (
        <Button variant="ghost" onClick={() => void load(cursor)}>
          Load more
        </Button>
      )}
    </div>
  );
}
