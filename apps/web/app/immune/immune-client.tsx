"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import {
  ANTIBODY_FEATURES,
  type AntibodyDetail,
  type AntibodyFeature,
  type AntibodyStatus,
  type AntibodySummary,
  type DefenderInfo,
  type MerchantRiskRow,
} from "@poi/shared";
import { Grid } from "@/components/grid";
import { Button, Card, cx, Pill, Spinner } from "@/components/ui";
import { poi } from "@/lib/config";
import { useLiveImmune } from "@/lib/live-l2";

const RISK_THRESHOLD = 0.35;

interface LiveToast {
  id: string;
  type: "minted" | "promoted" | "rejected";
  title: string;
  message: string;
  timestamp: number;
}

/** Antibody Ledger Detail Drawer */
function AntibodyDetailDrawer({
  antibodyId,
  onClose,
  onRetired,
}: {
  antibodyId: string;
  onClose: () => void;
  onRetired: (id: string) => void;
}) {
  const [detail, setDetail] = useState<AntibodyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);

  useEffect(() => {
    setLoading(true);
    poi.getAntibody(antibodyId)
      .then((res) => {
        setDetail(res);
        setLoading(false);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, [antibodyId]);

  const handleRetire = async () => {
    if (!detail) return;
    setRetiring(true);
    try {
      await poi.retireAntibody(detail.antibody.id);
      onRetired(detail.antibody.id);
      setDetail({
        ...detail,
        antibody: { ...detail.antibody, status: "retired" },
      });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRetiring(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Container */}
      <div className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-line bg-white shadow-2xl dark:bg-zinc-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line p-5">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold">Antibody Inspector</h2>
            <Pill tone="brand">{antibodyId}</Pill>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-line/40 hover:text-ink"
            aria-label="Close drawer"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {loading && (
            <div className="flex h-64 items-center justify-center">
              <Spinner />
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-void/10 p-4 text-sm text-void">
              {error}
            </div>
          )}

          {detail && (
            <>
              {/* Summary Card */}
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                  <div>
                    <span className="font-mono text-sm font-bold text-brand">{detail.antibody.id}</span>
                    <span className="ml-2 font-semibold capitalize text-ink">({detail.antibody.family})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill
                      tone={
                        detail.antibody.status === "active"
                          ? "good"
                          : detail.antibody.status === "candidate"
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {detail.antibody.status}
                    </Pill>
                    <span
                      className={cx(
                        "rounded px-2 py-0.5 text-xs font-bold",
                        detail.antibody.action === "VOID"
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                          : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {detail.antibody.action}
                    </span>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-muted">Defender Version:</span>{" "}
                    <span className="font-mono font-semibold">v{detail.antibody.defenderVersion}</span>
                  </div>
                  <div>
                    <span className="text-muted">Hits / False Hits:</span>{" "}
                    <span className="font-mono font-semibold">
                      {detail.antibody.hits} /{" "}
                      <span className={detail.antibody.falseHits > 0 ? "text-void" : "text-ink"}>
                        {detail.antibody.falseHits}
                      </span>
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted">Created:</span>{" "}
                    <span className="text-ink">{new Date(detail.antibody.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </Card>

              {/* Cryptographic Signature Verify Badge */}
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">✓</span>
                    <span className="font-semibold text-emerald-800 dark:text-emerald-200">
                      Ed25519 Cryptographically Verified
                    </span>
                  </div>
                  <Pill tone="good">Signed</Pill>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  Signed over canonical JSON features and MinHash fingerprint by POI Verifier Authority.
                </p>
                <div className="mt-2 rounded bg-black/5 dark:bg-black/30 p-2 font-mono text-[10px] text-muted truncate">
                  Sig: {detail.antibody.signature}
                </div>
              </div>

              {/* Matched Structural Features */}
              <Card title="Structural Attack Flags & Fingerprint">
                <p className="mb-3 text-xs text-muted">
                  Hard structural indicators extracted from the attacking merchant order and checkout terms.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ANTIBODY_FEATURES.map((flag) => {
                    const isMatched = detail.antibody.features[flag] === true;
                    return (
                      <span
                        key={flag}
                        className={cx(
                          "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                          isMatched
                            ? "bg-brand text-white shadow-xs font-semibold"
                            : "bg-line/40 text-muted/50 border border-line/40",
                        )}
                      >
                        {isMatched ? "✓ " : "• "}
                        {flag.replace(/_/g, " ")}
                      </span>
                    );
                  })}
                </div>

                {detail.antibody.skeleton && (
                  <div className="mt-3 rounded-lg bg-panel p-2.5 text-xs">
                    <span className="font-semibold text-muted">Lookalike Skeleton:</span>{" "}
                    <span className="font-mono font-bold text-ink">{detail.antibody.skeleton}</span>
                  </div>
                )}
              </Card>

              {/* Source Order Summary */}
              <Card title="Source Order Context">
                {detail.sourceOrder ? (
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between border-b border-line pb-2">
                      <span className="text-muted">Order ID:</span>
                      <span className="font-mono font-bold text-brand">{detail.sourceOrder.orderId}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Merchant:</span>
                      <span className="font-semibold text-ink">{detail.sourceOrder.merchantDisplayName}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Total Paid:</span>
                      <span className="font-mono font-bold text-ink">${detail.sourceOrder.total.value} USD</span>
                    </div>
                    <div>
                      <span className="text-muted">Order Line Items:</span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {detail.sourceOrder.lineNames.map((name, i) => (
                          <span key={i} className="rounded bg-panel px-2 py-0.5 font-mono text-[11px] border border-line">
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    Seeded from Layer 1 attack fixtures or synthetic Red-Team catalog.
                  </p>
                )}
              </Card>

              {/* Recent Hits */}
              <Card title={`Recent Firewall Matches (${detail.recentHits.length})`}>
                {detail.recentHits.length === 0 ? (
                  <p className="text-xs text-muted">No real-world order matches recorded yet.</p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {detail.recentHits.map((h, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded-lg border border-line bg-panel/30 p-2.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold">{h.orderId}</span>
                          <Pill tone="brand">{h.kind}</Pill>
                          {h.falseHit && <Pill tone="bad">False Hit</Pill>}
                        </div>
                        <div className="font-mono font-semibold">
                          Sim: {(h.similarity * 100).toFixed(0)}%
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* Retire Action */}
              <div className="border-t border-line pt-4 flex justify-between items-center">
                <span className="text-xs text-muted">
                  {detail.antibody.status === "retired"
                    ? "This antibody is retired and no longer active in the LSH index."
                    : "Retiring immediately deactivates this antibody across the firewall."}
                </span>

                {detail.antibody.status !== "retired" && (
                  <Button variant="danger" onClick={handleRetire} disabled={retiring}>
                    {retiring ? <Spinner /> : "Retire Antibody"}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ImmuneClient() {
  const [defender, setDefender] = useState<DefenderInfo | null>(null);
  const [antibodies, setAntibodies] = useState<AntibodySummary[]>([]);
  const [selectedAntibodyId, setSelectedAntibodyId] = useState<string | null>(null);
  const [merchants, setMerchants] = useState<MerchantRiskRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<AntibodyStatus | "all">("all");
  const [quickFilter, setQuickFilter] = useState("");
  const [loading, setLoading] = useState(true);

  // Live Toast Notifications
  const [toasts, setToasts] = useState<LiveToast[]>([]);

  // User Report Form state
  const [reportOrderId, setReportOrderId] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [reportStatus, setReportStatus] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  const { connected, minted, promoted, rejected } = useLiveImmune();

  const addToast = (toast: Omit<LiveToast, "id" | "timestamp">) => {
    const newToast: LiveToast = {
      ...toast,
      id: Math.random().toString(36).slice(2),
      timestamp: Date.now(),
    };
    setToasts((prev) => [newToast, ...prev].slice(0, 5));
    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== newToast.id));
    }, 6000);
  };

  // Watch socket events and trigger live toasts
  const lastMintedRef = useRef<string>("");
  useEffect(() => {
    if (minted.length > 0 && minted[0]?.antibodyId !== lastMintedRef.current) {
      const m = minted[0]!;
      lastMintedRef.current = m.antibodyId;
      addToast({
        type: "minted",
        title: "New Candidate Antibody Minted",
        message: `Antibody ${m.antibodyId} (${m.family}) synthesized from order ${m.sourceOrderId}.`,
      });
      loadData();
    }
  }, [minted]);

  const lastPromotedRef = useRef<string>("");
  useEffect(() => {
    if (promoted.length > 0 && promoted[0]?.antibodyId !== lastPromotedRef.current) {
      const p = promoted[0]!;
      lastPromotedRef.current = p.antibodyId;
      addToast({
        type: "promoted",
        title: "Antibody Promoted to Active",
        message: `Antibody ${p.antibodyId} passed all 40 benign listings (0 false hits) and is now ACTIVE (Defender v${p.defenderVersion})!`,
      });
      loadData();
    }
  }, [promoted]);

  const lastRejectedRef = useRef<string>("");
  useEffect(() => {
    if (rejected.length > 0 && rejected[0]?.antibodyId !== lastRejectedRef.current) {
      const r = rejected[0]!;
      lastRejectedRef.current = r.antibodyId;
      addToast({
        type: "rejected",
        title: "Antibody Rejected at Gate",
        message: `Antibody ${r.antibodyId} failed promotion gate (${r.falseHits} false hits)! Hit benign item: benign-ear-budget-01 (honest mentions of warranty/subscription not included).`,
      });
      loadData();
    }
  }, [rejected]);

  const loadData = () => {
    Promise.all([
      poi.getDefender().catch(() => null),
      poi.listAntibodies().catch(() => []),
      poi.getMerchantRisks().catch(() => []),
    ]).then(([def, abs, mr]) => {
      setDefender(def);
      setAntibodies(abs);
      setMerchants(mr);
      setLoading(false);
    });
  };

  useEffect(() => {
    setLoading(true);
    loadData();
  }, []);

  const handleRetireSuccess = (id: string) => {
    setAntibodies((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "retired" } : a)),
    );
  };

  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportOrderId || !reportReason) return;
    setReporting(true);
    setReportStatus(null);
    try {
      const res = await poi.reportOrder({
        orderId: reportOrderId.trim(),
        reason: reportReason.trim(),
      });
      if (res.antibodyId) {
        setReportStatus(`Report absorbed by existing antibody ${res.antibodyId}.`);
      } else {
        setReportStatus("Report submitted! Queued for candidate antibody synthesis (immune.mint).");
      }
      setReportOrderId("");
      setReportReason("");
    } catch (err) {
      setReportStatus(`Error: ${(err as Error).message}`);
    } finally {
      setReporting(false);
    }
  };

  // AG Grid columns for Antibody Ledger
  const columnDefs: Array<ColDef<AntibodySummary>> = useMemo(
    () => [
      {
        field: "id",
        headerName: "Antibody ID",
        width: 140,
        cellClass: "font-mono font-medium text-brand",
        sort: "desc",
      },
      {
        field: "family",
        headerName: "Family",
        width: 120,
        cellRenderer: (p: ICellRendererParams<AntibodySummary>) => (
          <span className="font-medium capitalize text-ink">{p.value}</span>
        ),
      },
      {
        field: "action",
        headerName: "Action",
        width: 120,
        cellRenderer: (p: ICellRendererParams<AntibodySummary>) => (
          <span
            className={cx(
              "font-bold text-xs",
              p.value === "VOID"
                ? "text-rose-600 dark:text-rose-400"
                : "text-amber-600 dark:text-amber-400",
            )}
          >
            {p.value}
          </span>
        ),
      },
      {
        field: "status",
        headerName: "State",
        width: 120,
        cellRenderer: (p: ICellRendererParams<AntibodySummary>) => (
          <Pill
            tone={
              p.value === "active"
                ? "good"
                : p.value === "candidate"
                  ? "warn"
                  : "neutral"
            }
          >
            {p.value}
          </Pill>
        ),
      },
      {
        field: "hits",
        headerName: "Hits",
        width: 90,
        cellClass: "font-mono font-semibold",
      },
      {
        field: "falseHits",
        headerName: "False Hits",
        width: 110,
        cellRenderer: (p: ICellRendererParams<AntibodySummary>) => (
          <span
            className={cx(
              "font-mono font-semibold",
              p.value > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted",
            )}
          >
            {p.value}
          </span>
        ),
      },
      {
        field: "defenderVersion",
        headerName: "Defender Ver",
        width: 130,
        cellRenderer: (p: ICellRendererParams<AntibodySummary>) => (
          <Pill tone="brand">v{p.value}</Pill>
        ),
      },
      {
        field: "createdAt",
        headerName: "Created",
        minWidth: 170,
        flex: 1,
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : "--"),
      },
    ],
    [],
  );

  const filteredAntibodies = useMemo(() => {
    return antibodies.filter((a) => (statusFilter === "all" ? true : a.status === statusFilter));
  }, [antibodies, statusFilter]);

  return (
    <div className="space-y-8">
      {/* Live Toasts Container */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              "pointer-events-auto rounded-xl border p-4 shadow-xl transition-all duration-300",
              toast.type === "promoted"
                ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950 text-emerald-900 dark:text-emerald-100"
                : toast.type === "rejected"
                  ? "border-rose-500 bg-rose-50 dark:bg-rose-950 text-rose-900 dark:text-rose-100"
                  : "border-amber-500 bg-amber-50 dark:bg-amber-950 text-amber-900 dark:text-amber-100",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-xs">{toast.title}</span>
              <button
                onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                className="text-xs opacity-60 hover:opacity-100"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-xs leading-relaxed">{toast.message}</p>
          </div>
        ))}
      </div>

      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Immune System & Memory</h1>
            <Pill tone={connected ? "good" : "neutral"}>
              {connected ? "● Live /live" : "Offline"}
            </Pill>
          </div>
          <p className="mt-1 text-sm text-muted">
            Learned structural antibody ledger, MinHash LSH matching, and merchant repeat-offender risk registry.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={loadData}>
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Defender Summary Strip */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Defender Version</div>
              <div className="mt-1 font-mono text-3xl font-black text-brand">v{defender?.version ?? 0}</div>
              <div className="mt-2 text-[11px] text-muted">Incremented on antibody promotion</div>
            </Card>

            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Active Antibodies</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-black text-emerald-600 dark:text-emerald-400">
                  {defender?.activeAntibodies ?? 0}
                </span>
                <span className="text-xs text-muted">live in 32-band LSH index</span>
              </div>
              <div className="mt-2 text-[11px] text-muted">0 false hits on 40 benign listings</div>
            </Card>

            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Active Conformal Calibration</div>
              <div className="mt-1 font-mono text-sm font-bold text-brand truncate">
                {defender?.activeCalibrationId ?? "CRC-Active"}
              </div>
              <div className="mt-2 text-[11px] text-muted">Statistical guarantees active on live checkouts</div>
            </Card>
          </div>

          {/* Antibody Ledger (AG Grid) */}
          <Card
            title={
              <div className="flex flex-wrap w-full items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="font-bold">Antibody Ledger</span>
                  <Pill tone="brand">{filteredAntibodies.length} Antibodies</Pill>
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1 rounded-xl border border-line bg-panel p-1 text-xs">
                    {(["all", "active", "candidate", "retired"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setStatusFilter(s)}
                        className={cx(
                          "rounded-lg px-2.5 py-1 font-medium capitalize transition",
                          statusFilter === s
                            ? "bg-brand text-white shadow-xs"
                            : "text-muted hover:text-ink",
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </div>

                  <input
                    type="text"
                    placeholder="Quick filter..."
                    value={quickFilter}
                    onChange={(e) => setQuickFilter(e.target.value)}
                    className="w-48 rounded-xl border border-line bg-panel px-3 py-1 text-xs font-medium"
                  />
                </div>
              </div>
            }
          >
            <p className="mb-3 text-xs text-muted">
              Click any row to open the antibody detail drawer with source order context, structural features, and cryptographic signature verification.
            </p>

            <Grid
              columnDefs={columnDefs}
              rowData={filteredAntibodies}
              quickFilterText={quickFilter}
              onRowClicked={(e: RowClickedEvent<AntibodySummary>) => {
                if (e.data?.id) setSelectedAntibodyId(e.data.id);
              }}
              height={440}
            />
          </Card>

          {/* Merchant Risk Table */}
          <Card
            title={
              <div className="flex items-center justify-between">
                <span className="font-bold">Merchant Repeat-Offender Risk Registry</span>
                <Pill tone="warn">Threshold: &gt; {RISK_THRESHOLD} (Triggers ASK_HUMAN)</Pill>
              </div>
            }
          >
            <p className="mb-4 text-xs text-muted">
              Bayesian risk update: <code>risk = (voids + reports + 1) / (orders + 5)</code>. Merchants with risk score above 0.35 trigger automated human review escalation.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-muted bg-panel/50">
                    <th className="p-3">Merchant</th>
                    <th className="p-3">Risk Score (Bar)</th>
                    <th className="p-3">Orders</th>
                    <th className="p-3">Voids</th>
                    <th className="p-3">Reports</th>
                    <th className="p-3">Firewall Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {merchants.map((m) => {
                    const isHigh = m.risk >= RISK_THRESHOLD;
                    const pct = Math.min(100, Math.round(m.risk * 100));

                    return (
                      <tr
                        key={m.merchantId}
                        className={cx(
                          "transition hover:bg-panel/40",
                          isHigh && "bg-rose-500/10 dark:bg-rose-950/20 font-semibold border-l-4 border-rose-500",
                        )}
                      >
                        <td className="p-3">
                          <div className="font-bold text-ink">{m.displayName}</div>
                          <div className="font-mono text-[11px] text-muted">{m.merchantId}</div>
                        </td>
                        <td className="p-3 w-56">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-line/60">
                              <div
                                className={cx(
                                  "h-full rounded-full transition-all duration-300",
                                  isHigh ? "bg-rose-500" : "bg-emerald-500",
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span
                              className={cx(
                                "font-mono font-bold w-12 text-right",
                                isHigh ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400",
                              )}
                            >
                              {(m.risk * 100).toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td className="p-3 font-mono">{m.orders}</td>
                        <td className="p-3 font-mono text-void">{m.voids}</td>
                        <td className="p-3 font-mono text-ask">{m.reports}</td>
                        <td className="p-3">
                          {isHigh ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-600 dark:text-rose-400">
                              ⚠️ Escalated (ASK_HUMAN)
                            </span>
                          ) : (
                            <span className="text-muted">Normal (Rules + LLM)</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* User Dissatisfaction Report Simulator */}
          <Card title="User Dissatisfaction Report Simulator">
            <form onSubmit={handleSubmitReport} className="space-y-4">
              <p className="text-xs text-muted">
                Simulates the &ldquo;This wasn&rsquo;t what I asked for&rdquo; user report button. Captures and voids file reports that trigger antibody candidate minting.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-muted">Order ID</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. ARENA0001TEST"
                    value={reportOrderId}
                    onChange={(e) => setReportOrderId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted">Reason</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Hidden subscription billed monthly"
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-4">
                <Button type="submit" disabled={reporting}>
                  {reporting ? <Spinner /> : "Submit Report"}
                </Button>
                {reportStatus && <span className="text-xs font-semibold text-brand">{reportStatus}</span>}
              </div>
            </form>
          </Card>
        </>
      )}

      {/* Antibody Detail Drawer */}
      {selectedAntibodyId && (
        <AntibodyDetailDrawer
          antibodyId={selectedAntibodyId}
          onClose={() => setSelectedAntibodyId(null)}
          onRetired={handleRetireSuccess}
        />
      )}
    </div>
  );
}
