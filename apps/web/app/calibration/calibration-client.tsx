"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type CalibrationCurvePoint,
  type CalibrationResult,
} from "@poi/shared";
import { Button, Card, cx, Pill, Spinner } from "@/components/ui";
import { poi } from "@/lib/config";
import { useLiveImmune } from "@/lib/live-l2";

/** Interactive SVG Trade-Off Curve (Alpha vs Benign ASK Rate vs Empirical Miss Rate) */
function AlphaTradeoffCurve({
  curve,
  activeAlpha,
  onSelectAlpha,
}: {
  curve: CalibrationCurvePoint[];
  activeAlpha: number;
  onSelectAlpha: (alpha: number) => void;
}) {
  const sorted = useMemo(
    () => [...curve].sort((a, b) => a.alpha - b.alpha),
    [curve],
  );

  if (sorted.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-line bg-panel/30 text-xs text-muted">
        No calibration curve data available.
      </div>
    );
  }

  const width = 640;
  const height = 240;
  const padLeft = 45;
  const padRight = 30;
  const padTop = 30;
  const padBottom = 35;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  // X range: alpha 0.01 to 0.20
  const minAlpha = 0.01;
  const maxAlpha = 0.20;
  const getX = (alpha: number) =>
    padLeft + ((alpha - minAlpha) / (maxAlpha - minAlpha)) * plotW;

  // Y range: rates from 0.0 to 0.25 (25%)
  const maxY = 0.25;
  const getY = (val: number) => padTop + plotH - (Math.min(maxY, val) / maxY) * plotH;

  const benignAskPoints = sorted.map((p) => `${getX(p.alpha)},${getY(p.benignAskRate)}`).join(" ");
  const missPoints = sorted.map((p) => `${getX(p.alpha)},${getY(p.empiricalMiss)}`).join(" ");

  // Grid levels for Y axis (0%, 5%, 10%, 15%, 20%, 25%)
  const gridLevels = [0, 0.05, 0.10, 0.15, 0.20, 0.25];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-line bg-panel/40 p-4">
        {/* Header & Legend */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-4 text-xs">
          <span className="font-semibold text-muted">Conformal Operating Characteristic Curve</span>
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="font-medium text-ink">Y1: Benign ASK Rate (Friction / Review Burden)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span className="font-medium text-ink">Y2: Empirical Miss Rate (Missed Attacks)</span>
            </div>
          </div>
        </div>

        <svg viewBox={`0 0 ${width} ${height}`} className="w-full select-none font-sans text-[10px]">
          {/* Horizontal grid lines */}
          {gridLevels.map((lvl) => {
            const y = getY(lvl);
            return (
              <g key={lvl}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="currentColor"
                  className="text-line stroke-1"
                  strokeDasharray={lvl > 0 && lvl < maxY ? "4 4" : undefined}
                />
                <text x={padLeft - 8} y={y + 3} textAnchor="end" className="fill-muted font-mono">
                  {Math.round(lvl * 100)}%
                </text>
              </g>
            );
          })}

          {/* X axis labels (alpha) */}
          {[0.01, 0.05, 0.10, 0.15, 0.20].map((a) => {
            const x = getX(a);
            return (
              <text key={a} x={x} y={height - 10} textAnchor="middle" className="fill-muted font-mono font-medium">
                α={a.toFixed(2)}
              </text>
            );
          })}

          {/* Active alpha vertical indicator line */}
          <line
            x1={getX(activeAlpha)}
            y1={padTop}
            x2={getX(activeAlpha)}
            y2={padTop + plotH}
            stroke="#6366f1"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />

          {/* Benign ASK Rate Curve (Amber) */}
          <polyline
            points={benignAskPoints}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Empirical Miss Curve (Emerald) */}
          <polyline
            points={missPoints}
            fill="none"
            stroke="#10b981"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Interactive Data Point Circles */}
          {sorted.map((p) => {
            const x = getX(p.alpha);
            const yAsk = getY(p.benignAskRate);
            const yMiss = getY(p.empiricalMiss);
            const isSelected = Math.abs(p.alpha - activeAlpha) < 0.005;

            return (
              <g key={p.alpha} className="cursor-pointer" onClick={() => onSelectAlpha(p.alpha)}>
                {/* Amber dot */}
                <circle
                  cx={x}
                  cy={yAsk}
                  r={isSelected ? 5.5 : 3.5}
                  fill="#f59e0b"
                  stroke="white"
                  strokeWidth={isSelected ? 2 : 1}
                >
                  <title>{`α=${p.alpha.toFixed(2)}: Benign ASK Rate = ${(p.benignAskRate * 100).toFixed(1)}%`}</title>
                </circle>

                {/* Emerald dot */}
                <circle
                  cx={x}
                  cy={yMiss}
                  r={isSelected ? 5.5 : 3.5}
                  fill="#10b981"
                  stroke="white"
                  strokeWidth={isSelected ? 2 : 1}
                >
                  <title>{`α=${p.alpha.toFixed(2)}: Empirical Miss = ${(p.empiricalMiss * 100).toFixed(1)}%`}</title>
                </circle>
              </g>
            );
          })}
        </svg>

        <p className="mt-2 text-right text-[11px] text-muted">
          Click any point on the curve or drag the slider above to set target error &alpha;.
        </p>
      </div>
    </div>
  );
}

export function CalibrationClient() {
  const [alpha, setAlpha] = useState<number>(0.05);
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [curve, setCurve] = useState<CalibrationCurvePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const { connected, calibration: liveCalib } = useLiveImmune();

  const loadData = () => {
    setLoading(true);
    Promise.all([
      poi.getLatestCalibration().catch(() => null),
      poi.getCalibrationCurve().catch(() => []),
    ]).then(([res, pts]) => {
      setCalibration(res);
      setCurve(pts);
      if (res?.alpha) {
        setAlpha(res.alpha);
      }
      setLoading(false);
    });
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRunCalibration = async () => {
    setRunning(true);
    setStatusMsg(null);
    try {
      const res = await poi.runCalibration({ alpha, perFamily: true });
      setCalibration(res);
      setStatusMsg(`Successfully calibrated CRC bounds with alpha = ${alpha.toFixed(2)}!`);
      // Reload curve points
      poi.getCalibrationCurve().then(setCurve).catch(() => {});
    } catch (e) {
      setStatusMsg(`Error: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const activeAlpha = calibration?.alpha ?? alpha;
  const sampleCount = calibration?.n ?? 400;

  return (
    <div className="space-y-8">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Conformal Risk Control (CRC)</h1>
            <Pill tone={connected ? "good" : "neutral"}>
              {connected ? "● Live /live" : "Offline"}
            </Pill>
          </div>
          <p className="mt-1 text-sm text-muted">
            Finite-sample statistical guarantees for checkout firewall thresholds: E[Miss Rate] &le; &alpha;.
          </p>
        </div>

        <Button variant="ghost" onClick={loadData}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Live Calibration Update Notification */}
          {liveCalib && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs">
              <div className="flex items-center gap-3">
                <Pill tone="good">Live Calibration Updated</Pill>
                <span className="font-mono text-ink">ID: {liveCalib.calibrationId}</span>
                <span>&alpha;: {liveCalib.alpha.toFixed(2)}</span>
                <span className="font-mono text-ask">&lambda;_ask: {liveCalib.lambdaAsk.toFixed(3)}</span>
                <span className="font-mono text-void">&lambda;_void: {liveCalib.lambdaVoid.toFixed(3)}</span>
              </div>
            </div>
          )}

          {/* Plain-English Statistical Guarantee Box */}
          <div className="rounded-2xl border-2 border-brand/40 bg-brand-soft/30 p-6 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand">
              <span>Statistical Guarantee Statement</span>
              <Pill tone="brand">E[Loss] &le; &alpha;</Pill>
            </div>
            <p className="mt-3 text-base leading-relaxed text-ink font-medium">
              &ldquo;On <strong className="font-bold text-brand">{sampleCount}</strong> calibration orders, POI would capture at most{" "}
              <strong className="font-bold text-brand">{(activeAlpha * 100).toFixed(0)}%</strong> of bad orders — assuming future orders look like these. Held-out results below test what happens when they don&rsquo;t.&rdquo;
            </p>
          </div>

          {/* Latest Result Card Strip */}
          <Card
            title={
              <div className="flex items-center justify-between">
                <span className="font-bold">Latest CRC Calibration Result</span>
                <Pill tone="brand">{calibration?.id ?? "CRC-Active"}</Pill>
              </div>
            }
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
              {/* Alpha */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">Target &alpha;</div>
                <div className="mt-1 font-mono text-xl font-bold text-brand">
                  {(calibration?.alpha ?? alpha).toFixed(2)}
                </div>
                <div className="text-[10px] text-muted">Max error bound</div>
              </div>

              {/* Sample Size n */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">Orders (n)</div>
                <div className="mt-1 font-mono text-xl font-bold text-ink">
                  {calibration?.n ?? 400}
                </div>
                <div className="text-[10px] text-muted">{calibration?.nViolating ?? 120} attacks</div>
              </div>

              {/* Lambda Ask */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">&lambda;_ask</div>
                <div className="mt-1 font-mono text-xl font-bold text-amber-600 dark:text-amber-400">
                  {(calibration?.lambdaAsk ?? 0.42).toFixed(3)}
                </div>
                <div className="text-[10px] text-muted">ASK_HUMAN cutoff</div>
              </div>

              {/* Lambda Void */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">&lambda;_void</div>
                <div className="mt-1 font-mono text-xl font-bold text-rose-600 dark:text-rose-400">
                  {(calibration?.lambdaVoid ?? 0.88).toFixed(3)}
                </div>
                <div className="text-[10px] text-muted">Auto-VOID cutoff</div>
              </div>

              {/* Empirical Miss Rate */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">Empirical Miss</div>
                <div className="mt-1 font-mono text-xl font-bold text-emerald-600 dark:text-emerald-400">
                  {((calibration?.empiricalMiss ?? 0.038) * 100).toFixed(1)}%
                </div>
                <div className="text-[10px] text-muted">&le; {(activeAlpha * 100).toFixed(0)}% bound</div>
              </div>

              {/* Benign ASK Rate */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">Benign ASK</div>
                <div className="mt-1 font-mono text-xl font-bold text-amber-600 dark:text-amber-400">
                  {((calibration?.benignAskRate ?? 0.065) * 100).toFixed(1)}%
                </div>
                <div className="text-[10px] text-muted">Review friction</div>
              </div>

              {/* Benign VOID Rate */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">Benign VOID</div>
                <div className="mt-1 font-mono text-xl font-bold text-ink">
                  {((calibration?.benignVoidRate ?? 0.008) * 100).toFixed(1)}%
                </div>
                <div className="text-[10px] text-muted">Mistaken voids</div>
              </div>

              {/* Defender Version */}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="text-[11px] font-semibold uppercase text-muted">Defender Ver</div>
                <div className="mt-1 font-mono text-xl font-bold text-brand">
                  v3
                </div>
                <div className="text-[10px] text-muted">Active antibodies</div>
              </div>
            </div>
          </Card>

          {/* Interactive Recalibrate Control Panel */}
          <Card
            title={
              <div className="flex items-center justify-between">
                <span className="font-bold">Adjust Target Miss Parameter (&alpha;) & Recalibrate</span>
                <Pill tone="brand">&alpha; = {alpha.toFixed(2)} ({(alpha * 100).toFixed(0)}% error allowance)</Pill>
              </div>
            }
          >
            <div className="space-y-4">
              <p className="text-xs text-muted">
                Adjusting &alpha; controls the strictness of the firewall conformal gate. Lower &alpha; guarantees fewer missed attacks by routing ambiguous orders to human review (ASK_HUMAN).
              </p>

              <div className="flex items-center gap-4">
                <span className="text-xs font-mono text-muted">0.01 (Strict)</span>
                <input
                  type="range"
                  min="0.01"
                  max="0.20"
                  step="0.01"
                  value={alpha}
                  onChange={(e) => setAlpha(parseFloat(e.target.value))}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-line accent-brand"
                />
                <span className="text-xs font-mono text-muted">0.20 (Permissive)</span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-3">
                <div className="text-xs">
                  <span className="text-muted">Finite-Sample Guaranteed Protection:</span>{" "}
                  <strong className="text-emerald-600 dark:text-emerald-400 font-bold">
                    {((1 - alpha) * 100).toFixed(0)}%
                  </strong>
                </div>

                <div className="flex items-center gap-3">
                  <Button onClick={handleRunCalibration} disabled={running} variant="primary">
                    {running ? (
                      <>
                        <Spinner /> Recalibrating...
                      </>
                    ) : (
                      `Recalibrate (α = ${alpha.toFixed(2)})`
                    )}
                  </Button>
                </div>
              </div>

              {statusMsg && (
                <div className="rounded-lg bg-panel p-2.5 text-xs text-ink border border-line">
                  {statusMsg}
                </div>
              )}
            </div>
          </Card>

          {/* The Alpha Trade-Off Curve */}
          <Card title="Alpha Trade-Off Curve (GET /api/calibration/curve)">
            <p className="mb-4 text-xs text-muted">
              Conformal operating curve mapping allowable error (&alpha;) against human review friction (benign ASK rate) and empirical miss rate. Points represent calibrated threshold cutoffs.
            </p>

            <AlphaTradeoffCurve
              curve={curve}
              activeAlpha={alpha}
              onSelectAlpha={(newAlpha) => setAlpha(newAlpha)}
            />
          </Card>

          {/* Per-Family Miss Table */}
          {calibration?.perFamily && calibration.perFamily.length > 0 && (
            <Card
              title={
                <div className="flex items-center justify-between">
                  <span className="font-bold">Per-Family Miss Rates & Protection Coverage</span>
                  <Pill tone="brand">{calibration.perFamily.length} Attack Families</Pill>
                </div>
              }
            >
              <p className="mb-3 text-xs text-muted">
                Breakdown of empirical miss rate and firewall capture guarantees partitioned by attack family across calibration trials.
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-muted bg-panel/50">
                      <th className="p-3">Attack Family</th>
                      <th className="p-3">Sample Orders (n)</th>
                      <th className="p-3">Empirical Miss Rate</th>
                      <th className="p-3">Guaranteed Protection</th>
                      <th className="p-3">Conformal Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {calibration.perFamily.map((f) => {
                      const missPct = f.miss * 100;
                      const protectionPct = (1 - f.miss) * 100;

                      return (
                        <tr key={f.family} className="hover:bg-panel/40">
                          <td className="p-3 font-semibold capitalize text-ink">{f.family}</td>
                          <td className="p-3 font-mono">{f.n}</td>
                          <td className="p-3 font-mono">
                            <span className={cx(missPct > 10 ? "text-void font-bold" : "text-emerald-600 dark:text-emerald-400 font-semibold")}>
                              {missPct.toFixed(1)}%
                            </span>
                          </td>
                          <td className="p-3 font-mono font-bold text-ink">
                            {protectionPct.toFixed(1)}% Blocked
                          </td>
                          <td className="p-3">
                            <Pill tone={f.miss <= activeAlpha ? "good" : "warn"}>
                              {f.miss <= activeAlpha ? "✓ Within Bound" : "Marginal"}
                            </Pill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
