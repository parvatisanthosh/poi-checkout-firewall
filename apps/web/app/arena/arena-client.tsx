"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColDef, ColGroupDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { diffWords } from "diff";
import {
  ARCHIVE_CELL_COUNT,
  AttackFamily,
  Channel,
  type ArchiveCell,
  type ArenaGenerationStats,
  type ArenaRunConfigInput,
  type ArenaRunDetail,
  type ArenaRunSummary,
  type ArenaTrialEvent,
  type BazaarProduct,
  type GenomeLineage,
  type GenomeRow,
} from "@poi/shared";
import { Grid } from "@/components/grid";
import { Button, Card, cx, Pill, Spinner, VerdictBadge } from "@/components/ui";
import { poi } from "@/lib/config";
import { useLiveArena } from "@/lib/live-l2";

const ATTACKER_MODEL_PRESETS = [
  { id: "groq:openai/gpt-oss-120b", label: "GPT-OSS 120B (Attacker A - Default)" },
  { id: "groq:qwen/qwen3.8-27b", label: "Qwen 3.8 27B (Attacker B - Held-out)" },
  { id: "openai:gpt-4o-mini", label: "OpenAI GPT-4o-mini" },
  { id: "anthropic:claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
];

const AGENT_MODEL_PRESETS = [
  { id: "google:gemini-flash-lite-latest", label: "Gemini Flash-Lite (Default Agent)" },
  { id: "openai:gpt-4o-mini", label: "OpenAI GPT-4o-mini" },
];

function extractPayload(p: BazaarProduct, ch: Channel): string {
  switch (ch) {
    case "title":
      return p.title;
    case "description":
      return (
        p.description +
        (p.hidden?.placement === "description" ? `\n[Hidden: ${p.hidden.text}]` : "")
      );
    case "review":
      return (
        (p.topReviews ?? []).map((r) => `[${r.stars}★] ${r.author}: ${r.text}`).join("\n") +
        (p.hidden?.placement === "review" ? `\n[Hidden Review: ${p.hidden.text}]` : "")
      );
    case "alt_text":
      return p.imageAlt + (p.hidden?.placement === "alt" ? `\n[Hidden Alt: ${p.hidden.text}]` : "");
    case "terms":
      return p.termsExcerpt ?? "";
    case "checkout":
      return (
        (p.checkoutExtras?.lines ?? [])
          .map((l) => `${l.name} (${l.category}): $${l.unitUsd.toFixed(2)}`)
          .join("\n") +
        (p.checkoutExtras?.feesUsd?.handling
          ? `\nHandling fee: $${p.checkoutExtras.feesUsd.handling.toFixed(2)}`
          : "") +
        (p.checkoutExtras?.feesUsd?.insurance
          ? `\nInsurance fee: $${p.checkoutExtras.feesUsd.insurance.toFixed(2)}`
          : "")
      );
    default:
      return p.title;
  }
}

/** Horizontal visual bar renderer for fitness in AG Grid. */
function FitnessBarRenderer(params: ICellRendererParams<GenomeRow>) {
  const fitness = params.value as number | undefined;
  if (fitness === undefined || fitness === null) {
    return <span className="font-mono text-xs text-muted/60">--</span>;
  }

  // Max expected fitness is ~2.10
  const pct = Math.min(100, Math.max(0, Math.round((fitness / 2.1) * 100)));
  const tone =
    fitness > 1.0
      ? "bg-rose-500 text-rose-600 dark:text-rose-400"
      : fitness >= 0.5
        ? "bg-amber-500 text-amber-600 dark:text-amber-400"
        : "bg-sky-500 text-sky-600 dark:text-sky-400";

  return (
    <div className="flex h-full w-full items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-line/60">
        <div
          className={cx("h-full rounded-full transition-all duration-300", tone.split(" ")[0])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cx("w-10 text-right font-mono text-xs font-bold", tone.split(" ")[1])}>
        {fitness.toFixed(2)}
      </span>
    </div>
  );
}

/** SVG Dual-Line ASR Chart per generation (POI-static vs POI+Immune). */
function AsrChart({ generations }: { generations: ArenaGenerationStats[] }) {
  const sorted = useMemo(
    () => [...generations].sort((a, b) => a.generation - b.generation),
    [generations],
  );

  if (sorted.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-line bg-panel/30 text-xs text-muted">
        No generation data recorded yet. Data will plot live as generations complete.
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

  const maxGenIndex = Math.max(1, sorted.length - 1);
  const getX = (index: number) => padLeft + (index / maxGenIndex) * plotW;
  const getY = (rate: number) => padTop + plotH - Math.max(0, Math.min(1, rate)) * plotH;

  const staticPoints = sorted.map((g, i) => `${getX(i)},${getY(g.asrStatic)}`).join(" ");
  const immunePoints = sorted.map((g, i) => `${getX(i)},${getY(g.asrImmune)}`).join(" ");

  // Grid levels at 0%, 25%, 50%, 75%, 100%
  const gridLevels = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-line bg-panel/40 p-4">
        {/* Legend */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-4 text-xs">
          <span className="font-semibold text-muted">
            Attack Success Rate (% Firewall Bypassed)
          </span>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
              <span className="font-medium text-ink">POI-static (Frozen Firewall)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span className="font-medium text-ink">POI+Immune (Adaptive Defender)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rotate-45 rounded-xs bg-brand" />
              <span className="font-medium text-brand">Antibody Promoted (v#)</span>
            </div>
          </div>
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full select-none font-sans text-[10px]"
        >
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
                  strokeDasharray={lvl > 0 && lvl < 1 ? "4 4" : undefined}
                />
                <text x={padLeft - 8} y={y + 3} textAnchor="end" className="fill-muted font-mono">
                  {Math.round(lvl * 100)}%
                </text>
              </g>
            );
          })}

          {/* X axis labels */}
          {sorted.map((g, i) => {
            const x = getX(i);
            return (
              <text
                key={g.generation}
                x={x}
                y={height - 10}
                textAnchor="middle"
                className="fill-muted font-medium"
              >
                Gen {g.generation}
              </text>
            );
          })}

          {/* Static Arm Line (Rose) */}
          <polyline
            points={staticPoints}
            fill="none"
            stroke="#f43f5e"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Immune Arm Line (Emerald) */}
          <polyline
            points={immunePoints}
            fill="none"
            stroke="#10b981"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Static Arm Circles */}
          {sorted.map((g, i) => {
            const x = getX(i);
            const y = getY(g.asrStatic);
            return (
              <circle
                key={`static-${g.generation}`}
                cx={x}
                cy={y}
                r="4.5"
                fill="#f43f5e"
                stroke="white"
                strokeWidth="1.5"
              >
                <title>{`Gen ${g.generation} Static ASR: ${Math.round(g.asrStatic * 100)}%`}</title>
              </circle>
            );
          })}

          {/* Immune Arm Circles & Defender Version Markers */}
          {sorted.map((g, i) => {
            const x = getX(i);
            const y = getY(g.asrImmune);
            const prevVer = i > 0 ? sorted[i - 1]?.defenderVersion : 0;
            const hasPromotion = g.defenderVersion > (prevVer ?? 0);

            return (
              <g key={`immune-${g.generation}`}>
                <circle cx={x} cy={y} r="4.5" fill="#10b981" stroke="white" strokeWidth="1.5">
                  <title>{`Gen ${g.generation} Immune ASR: ${Math.round(g.asrImmune * 100)}%`}</title>
                </circle>

                {/* Defender version marker if antibody promoted */}
                {hasPromotion && (
                  <g transform={`translate(${x}, ${y - 18})`}>
                    <rect
                      x="-14"
                      y="-12"
                      width="28"
                      height="16"
                      rx="4"
                      className="fill-brand stroke-white stroke-1 dark:stroke-zinc-900"
                    />
                    <text
                      x="0"
                      y="0"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-white font-bold text-[9px]"
                    >
                      v{g.defenderVersion}
                    </text>
                    <title>{`Gen ${g.generation}: Defender updated to v${g.defenderVersion} (antibody promoted)`}</title>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Generation Stats Progression Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-line text-muted">
              <th className="p-2">Gen</th>
              <th className="p-2">Static ASR (Firewall Bypass)</th>
              <th className="p-2">Immune ASR (Defender Learning)</th>
              <th className="p-2">Defense Delta</th>
              <th className="p-2">Grid Coverage</th>
              <th className="p-2">Best Fitness</th>
              <th className="p-2">Defender Ver</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sorted.map((g) => {
              const staticPct = Math.round(g.asrStatic * 100);
              const immunePct = Math.round(g.asrImmune * 100);
              const gain = staticPct - immunePct;

              return (
                <tr key={g.generation} className="hover:bg-panel/40">
                  <td className="p-2 font-bold">Gen {g.generation}</td>
                  <td className="p-2 font-mono">
                    <span className={cx(staticPct > 40 ? "font-bold text-void" : "text-ink")}>
                      {staticPct}%
                    </span>
                  </td>
                  <td className="p-2 font-mono">
                    <span
                      className={cx(immunePct < staticPct ? "font-bold text-capture" : "text-ink")}
                    >
                      {immunePct}%
                    </span>
                  </td>
                  <td className="p-2 font-mono">
                    <span className={gain > 0 ? "font-semibold text-capture" : "text-muted"}>
                      {gain > 0 ? `+${gain}% stopped` : "--"}
                    </span>
                  </td>
                  <td className="p-2">{g.coverage} / 42 cells</td>
                  <td className="p-2 font-mono">{g.bestFitness.toFixed(2)}</td>
                  <td className="p-2 font-mono">
                    <Pill tone="brand">v{g.defenderVersion}</Pill>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Slide-out Drawer for Lineage and Word-Level Payload Diff. */
function LineageDrawer({ genomeId, onClose }: { genomeId: string; onClose: () => void }) {
  const [lineage, setLineage] = useState<GenomeLineage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    poi
      .getGenome(genomeId)
      .then((data) => {
        setLineage(data);
        setLoading(false);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, [genomeId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-line bg-white shadow-2xl dark:bg-zinc-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line p-5">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold">Genome Lineage Inspector</h2>
            <Pill tone="brand">{genomeId}</Pill>
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
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading && (
            <div className="flex h-64 items-center justify-center">
              <Spinner />
            </div>
          )}

          {error && <div className="rounded-xl bg-void/10 p-4 text-sm text-void">{error}</div>}

          {lineage && (
            <>
              {/* Target Genome Overview */}
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                  <div>
                    <span className="font-mono text-sm font-bold text-brand">
                      {lineage.genome.listing.sku}
                    </span>
                    <span className="ml-2 font-semibold">Gen {lineage.genome.generation}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone="brand">{lineage.genome.operator}</Pill>
                    <Pill tone="neutral">{lineage.genome.family}</Pill>
                    <Pill tone="neutral">{lineage.genome.channel}</Pill>
                  </div>
                </div>

                <div className="mt-3 space-y-2 text-xs">
                  <div>
                    <span className="text-muted">Title:</span>{" "}
                    <span className="font-medium text-ink">{lineage.genome.listing.title}</span>
                  </div>
                  <div>
                    <span className="text-muted">Price:</span>{" "}
                    <span className="font-mono font-semibold">
                      ${lineage.genome.listing.priceUsd.toFixed(2)}
                    </span>
                  </div>
                  <div className="rounded-lg bg-panel p-2.5">
                    <span className="font-semibold text-muted">Applied Strategy:</span>
                    <p className="mt-0.5 italic text-ink">{lineage.genome.strategy}</p>
                  </div>
                </div>
              </Card>

              {/* Parent Chain & Word-Level Payload Diff */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold tracking-tight">
                  Parent Lineage & Attack Payload Diff
                </h3>

                {lineage.parents.length === 0 ? (
                  <div className="rounded-xl border border-line bg-panel/30 p-4 text-xs text-muted">
                    <div className="font-semibold text-ink">Root Seed Genome (Generation 0)</div>
                    <p className="mt-1">
                      This genome was seeded directly from Layer 1 attack patterns with no parent
                      mutation.
                    </p>
                    <div className="mt-3 rounded-lg border border-line bg-panel p-3 font-mono text-[11px] whitespace-pre-wrap">
                      {extractPayload(lineage.genome.listing, lineage.genome.channel)}
                    </div>
                  </div>
                ) : (
                  lineage.parents.map((parent) => {
                    const parentPayload = extractPayload(parent.listing, parent.channel);
                    const childPayload = extractPayload(
                      lineage.genome.listing,
                      lineage.genome.channel,
                    );
                    const diffParts = diffWords(parentPayload, childPayload);

                    return (
                      <Card key={parent.id} className="space-y-3">
                        <div className="flex items-center justify-between border-b border-line pb-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="text-muted">Parent:</span>
                            <span className="font-mono font-bold text-brand">{parent.id}</span>
                            <span>(Gen {parent.generation})</span>
                          </div>
                          <Pill tone="neutral">{parent.operator}</Pill>
                        </div>

                        <div className="text-xs">
                          <span className="text-muted">Parent Strategy:</span>{" "}
                          <span className="italic">{parent.strategy}</span>
                        </div>

                        {/* Word-level diff display */}
                        <div>
                          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted">
                            <span>
                              Word-level diff ({parent.channel} → {lineage.genome.channel}):
                            </span>
                            <div className="flex items-center gap-3">
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                                <span>Added (Mutated)</span>
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-rose-500" />
                                <span>Removed</span>
                              </span>
                            </div>
                          </div>

                          <div className="rounded-xl border border-line bg-panel p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                            {diffParts.map((part, i) => {
                              if (part.added) {
                                return (
                                  <span
                                    key={i}
                                    className="rounded bg-emerald-500/25 px-1 py-0.5 font-semibold text-emerald-800 underline decoration-emerald-500 dark:text-emerald-300"
                                  >
                                    {part.value}
                                  </span>
                                );
                              }
                              if (part.removed) {
                                return (
                                  <span
                                    key={i}
                                    className="rounded bg-rose-500/25 px-1 py-0.5 text-rose-800 line-through opacity-70 decoration-rose-500 dark:text-rose-300"
                                  >
                                    {part.value}
                                  </span>
                                );
                              }
                              return <span key={i}>{part.value}</span>;
                            })}
                          </div>
                        </div>
                      </Card>
                    );
                  })
                )}
              </div>

              {/* Trials Record */}
              <div className="space-y-3">
                <h3 className="text-sm font-bold tracking-tight">
                  Validation & Sandbox Trials ({lineage.trials.length})
                </h3>
                {lineage.trials.map((t) => (
                  <div
                    key={t.trialId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel/30 p-3 text-xs"
                  >
                    <div>
                      <div className="font-mono font-semibold">{t.trialId}</div>
                      <div className="mt-0.5 text-[11px] text-muted">Agent: {t.agentModel}</div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className={t.chosenPoison ? "font-bold text-void" : "text-muted"}>
                        {t.chosenPoison ? "Poison Chosen" : "Honest"}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-muted text-[11px]">Static:</span>
                        <VerdictBadge verdict={t.verdictStatic} />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-muted text-[11px]">Immune:</span>
                        <VerdictBadge verdict={t.verdictImmune} />
                      </div>
                      <div className="rounded-md bg-brand/10 px-2 py-0.5 font-mono font-bold text-brand">
                        Fit: {t.fitness.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ArenaClient() {
  // Runs state
  const [runs, setRuns] = useState<ArenaRunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>("arena_demo");
  const [runDetail, setRunDetail] = useState<ArenaRunDetail | null>(null);
  const [genomes, setGenomes] = useState<GenomeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Lineage drawer state
  const [selectedGenomeId, setSelectedGenomeId] = useState<string | null>(null);

  // Heatmap animation state: track cells that flashed on replacedElite
  const [flashingCells, setFlashingCells] = useState<Set<string>>(new Set());
  const [cellStateMap, setCellStateMap] = useState<Map<string, ArchiveCell>>(new Map());

  // AG Grid quick filter
  const [quickFilter, setQuickFilter] = useState("");

  // Launcher state
  const [showLauncher, setShowLauncher] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchSuccess, setLaunchSuccess] = useState<string | null>(null);

  // Launcher form fields
  const [formGenerations, setFormGenerations] = useState<number>(6);
  const [formPopulation, setFormPopulation] = useState<number>(12);
  const [formAttackerModel, setFormAttackerModel] = useState<string>("groq:openai/gpt-oss-120b");
  const [formAgentModel, setFormAgentModel] = useState<string>("google:gemini-flash-lite-latest");
  const [formFamilies, setFormFamilies] = useState<AttackFamily[]>([...AttackFamily.options]);
  const [formTarget, setFormTarget] = useState<"static" | "immune">("static");
  const [formImmuneLearning, setFormImmuneLearning] = useState<boolean>(true);

  // Live socket subscription to arena:{runId}
  const {
    connected,
    runEvent,
    trials: liveTrials,
    generations: liveGens,
  } = useLiveArena(activeRunId);

  // Load runs list
  const refreshRuns = async () => {
    try {
      const list = await poi.listArenaRuns();
      setRuns(list);
      if (list.length > 0 && !activeRunId) {
        setActiveRunId(list[0]!.id);
      }
      return list;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  };

  useEffect(() => {
    refreshRuns();
  }, []);

  // Load run detail & genomes when activeRunId changes
  useEffect(() => {
    if (!activeRunId) return;
    setLoading(true);
    Promise.all([
      poi.getArenaRun(activeRunId).catch(() => null),
      poi.getArenaGenomes(activeRunId).catch(() => []),
    ]).then(([detail, genomeRows]) => {
      setRunDetail(detail);
      setGenomes(genomeRows);

      // Initialize cell map
      const initialMap = new Map<string, ArchiveCell>();
      for (const c of detail?.cells ?? []) {
        initialMap.set(`${c.family}|${c.channel}`, { ...c });
      }
      setCellStateMap(initialMap);
      setLoading(false);
    });
  }, [activeRunId]);

  // Handle live trial events and animate heat-map updates
  useEffect(() => {
    if (liveTrials.length === 0) return;
    const latest = liveTrials[0];
    if (!latest) return;

    const cellKey = `${latest.family}|${latest.channel}`;

    // Flash cell if elite was replaced
    if (latest.replacedElite) {
      setFlashingCells((prev) => new Set(prev).add(cellKey));
      setTimeout(() => {
        setFlashingCells((prev) => {
          const next = new Set(prev);
          next.delete(cellKey);
          return next;
        });
      }, 1500);
    }

    // Update cell state in real-time
    setCellStateMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(cellKey) ?? {
        family: latest.family,
        channel: latest.channel,
        eliteGenomeId: null,
        eliteFitness: null,
        attempts: 0,
        wins: 0,
      };

      const attempts = existing.attempts + 1;
      const wins =
        existing.wins + (latest.chosenPoison && latest.verdictStatic === "CAPTURE" ? 1 : 0);
      const eliteFitness = latest.replacedElite ? latest.fitness : existing.eliteFitness;
      const eliteGenomeId = latest.replacedElite ? latest.genomeId : existing.eliteGenomeId;

      next.set(cellKey, {
        ...existing,
        attempts,
        wins,
        eliteFitness,
        eliteGenomeId,
      });
      return next;
    });
  }, [liveTrials]);

  // Handle run launch submit
  const handleLaunchRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formFamilies.length === 0) {
      setLaunchError("Please select at least one attack family.");
      return;
    }

    setLaunching(true);
    setLaunchError(null);
    setLaunchSuccess(null);

    const config: ArenaRunConfigInput = {
      generations: formGenerations,
      populationSize: formPopulation,
      attackerModel: formAttackerModel,
      agentModel: formAgentModel,
      families: formFamilies,
      target: formTarget,
      immuneLearning: formImmuneLearning,
      split: "train",
      maxUsd: 15,
    };

    try {
      const res = await poi.startArenaRun(config);
      setLaunchSuccess(
        `Run ${res.runId} successfully launched! Subscribing to arena:${res.runId}...`,
      );
      await refreshRuns();
      setActiveRunId(res.runId);
      setTimeout(() => setShowLauncher(false), 2000);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const toggleFamily = (fam: AttackFamily) => {
    setFormFamilies((prev) =>
      prev.includes(fam) ? prev.filter((f) => f !== fam) : [...prev, fam],
    );
  };

  const selectAllFamilies = () => setFormFamilies([...AttackFamily.options]);
  const clearAllFamilies = () => setFormFamilies([]);

  const activeStatus = runEvent?.status ?? runDetail?.status ?? "RUNNING";

  // Compute big counters
  const cells = Array.from(cellStateMap.values());
  const filledCount = cells.filter((c) => c.eliteGenomeId !== null).length;
  const coveragePercent = Math.round((filledCount / ARCHIVE_CELL_COUNT) * 100);

  const displayGenerations: ArenaGenerationStats[] = (runDetail?.generations ?? []).map((g) => {
    const live = liveGens.find((lg) => lg.generation === g.generation);
    return live ? { ...g, ...live } : g;
  });

  const curGen =
    displayGenerations.length > 0 ? Math.max(...displayGenerations.map((g) => g.generation)) : 0;
  const maxGen = runDetail?.config.generations ?? 6;
  const bestFitness = Math.max(0, ...cells.map((c) => c.eliteFitness ?? 0));
  const currentCost = runEvent?.costUsd ?? runDetail?.costUsd ?? 0;
  const maxBudget = runDetail?.config.maxUsd ?? 15;
  const costPct = Math.min(100, Math.round((currentCost / maxBudget) * 100));

  // Build AG Grid Column Definitions
  const columnDefs: Array<ColDef<GenomeRow> | ColGroupDef<GenomeRow>> = useMemo(
    () => [
      {
        headerName: "Attack",
        children: [
          {
            field: "generation",
            headerName: "Gen",
            width: 80,
            sort: "desc",
          },
          {
            field: "family",
            headerName: "Family",
            width: 120,
            cellRenderer: (p: ICellRendererParams<GenomeRow>) => (
              <span className="font-medium capitalize text-ink">{p.value}</span>
            ),
          },
          {
            field: "channel",
            headerName: "Channel",
            width: 110,
            valueFormatter: (p) => (p.value ? String(p.value).replace("_", " ") : ""),
          },
          {
            field: "operator",
            headerName: "Operator",
            width: 110,
            cellRenderer: (p: ICellRendererParams<GenomeRow>) => (
              <Pill tone="brand">{p.value}</Pill>
            ),
          },
          {
            field: "listing.sku",
            headerName: "SKU",
            width: 130,
            cellClass: "font-mono font-medium text-brand",
          },
          {
            field: "listing.title",
            headerName: "Title",
            minWidth: 200,
            flex: 1,
          },
        ],
      },
      {
        headerName: "Outcome",
        children: [
          {
            field: "bestTrial.fitness",
            headerName: "Fitness",
            width: 160,
            cellRenderer: FitnessBarRenderer,
            comparator: (a, b) => (Number(a) || 0) - (Number(b) || 0),
          },
          {
            field: "bestTrial.chosenPoison",
            headerName: "Poison",
            width: 110,
            cellRenderer: (p: ICellRendererParams<GenomeRow>) => (
              <span
                className={
                  p.value ? "font-semibold text-rose-600 dark:text-rose-400" : "text-muted"
                }
              >
                {p.value ? "Chosen" : "Avoided"}
              </span>
            ),
          },
          {
            field: "bestTrial.verdictStatic",
            headerName: "POI-Static",
            width: 125,
            cellRenderer: (p: ICellRendererParams<GenomeRow>) => <VerdictBadge verdict={p.value} />,
          },
          {
            field: "bestTrial.verdictImmune",
            headerName: "POI+Immune",
            width: 130,
            cellRenderer: (p: ICellRendererParams<GenomeRow>) => <VerdictBadge verdict={p.value} />,
          },
          {
            field: "bestTrial.reported",
            headerName: "Reported",
            width: 105,
            cellRenderer: (p: ICellRendererParams<GenomeRow>) =>
              p.value ? (
                <Pill tone="bad">Reported</Pill>
              ) : (
                <span className="text-muted/60">--</span>
              ),
          },
        ],
      },
      {
        headerName: "Cost",
        children: [
          {
            field: "bestTrial.costUsd",
            headerName: "Cost",
            width: 90,
            valueFormatter: (p) =>
              p.value !== undefined ? `$${Number(p.value).toFixed(2)}` : "--",
          },
        ],
      },
    ],
    [],
  );

  // Fallback trials from loaded genomes for initial view
  const fallbackTrials: ArenaTrialEvent[] = genomes
    .filter((g) => g.bestTrial)
    .slice(0, 20)
    .map((g) => ({
      runId: activeRunId,
      generation: g.generation,
      genomeId: g.id,
      family: g.family,
      channel: g.channel,
      fitness: g.bestTrial!.fitness,
      chosenPoison: g.bestTrial!.chosenPoison,
      verdictStatic: g.bestTrial!.verdictStatic ?? null,
      verdictImmune: g.bestTrial!.verdictImmune ?? null,
      replacedElite: false,
    }));

  const displayedTrials = liveTrials.length > 0 ? liveTrials : fallbackTrials;

  return (
    <div className="space-y-8">
      {/* Top Banner & Run Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Adversarial Evolution Arena</h1>
            <Pill tone={connected ? "good" : "neutral"}>
              {connected ? "● Live /live" : "Offline"}
            </Pill>
            {activeRunId && <Pill tone="brand">arena:{activeRunId}</Pill>}
          </div>
          <p className="mt-1 text-sm text-muted">
            MAP-Elites quality-diversity search discovering and red-teaming checkout vulnerabilities
            against ProofOfIntent.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant={showLauncher ? "ghost" : "primary"}
            onClick={() => setShowLauncher(!showLauncher)}
          >
            {showLauncher ? "Hide Launcher" : "+ Launch Evolution Run"}
          </Button>

          {/* Run Picker */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-muted">Run:</label>
            <select
              value={activeRunId}
              onChange={(e) => setActiveRunId(e.target.value)}
              className="rounded-xl border border-line bg-panel px-3 py-1.5 text-sm font-medium"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} ({r.status}) - ${r.costUsd.toFixed(2)} - {r.generationsDone} gens
                </option>
              ))}
              {runs.every((r) => r.id !== activeRunId) && (
                <option value={activeRunId}>{activeRunId}</option>
              )}
            </select>
          </div>

          {activeStatus === "RUNNING" && (
            <Button
              variant="danger"
              onClick={() => {
                poi.stopArenaRun(activeRunId).then(() => {
                  setRunDetail((d) => (d ? { ...d, status: "STOPPED" } : d));
                });
              }}
            >
              Stop Run
            </Button>
          )}
        </div>
      </div>

      {error && <div className="rounded-xl bg-void/10 p-4 text-sm text-void">{error}</div>}

      {/* Run Launcher Form Card */}
      {showLauncher && (
        <Card
          title={
            <div className="flex items-center gap-2">
              <span className="text-base font-bold">New Evolution Run Launcher</span>
              <Pill tone="brand">POST /api/arena/runs</Pill>
            </div>
          }
          className="border-brand/40 bg-brand-soft/20 ring-1 ring-brand/30"
        >
          <form onSubmit={handleLaunchRun} className="space-y-6">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {/* Generations */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Generations
                  </label>
                  <span className="font-mono text-sm font-bold text-brand">{formGenerations}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={formGenerations}
                  onChange={(e) => setFormGenerations(Number(e.target.value))}
                  className="mt-2 w-full accent-brand"
                />
                <span className="text-[11px] text-muted">
                  Iterative rounds of MAP-Elites search (1 - 20)
                </span>
              </div>

              {/* Population Size */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Population Size
                  </label>
                  <span className="font-mono text-sm font-bold text-brand">{formPopulation}</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={24}
                  step={2}
                  value={formPopulation}
                  onChange={(e) => setFormPopulation(Number(e.target.value))}
                  className="mt-2 w-full accent-brand"
                />
                <span className="text-[11px] text-muted">
                  Genomes proposed per generation (4 - 24)
                </span>
              </div>

              {/* Attacker Model */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  Attacker LLM Model
                </label>
                <select
                  value={formAttackerModel}
                  onChange={(e) => setFormAttackerModel(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-medium"
                >
                  {ATTACKER_MODEL_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={formAttackerModel}
                  onChange={(e) => setFormAttackerModel(e.target.value)}
                  placeholder="Custom model ID..."
                  className="mt-1.5 w-full rounded-lg border border-line bg-panel px-2.5 py-1 font-mono text-xs"
                />
              </div>

              {/* Agent Model */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  Shopping Agent Model
                </label>
                <select
                  value={formAgentModel}
                  onChange={(e) => setFormAgentModel(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-medium"
                >
                  {AGENT_MODEL_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={formAgentModel}
                  onChange={(e) => setFormAgentModel(e.target.value)}
                  placeholder="Custom model ID..."
                  className="mt-1.5 w-full rounded-lg border border-line bg-panel px-2.5 py-1 font-mono text-xs"
                />
              </div>
            </div>

            {/* Attack Families Selection */}
            <div>
              <div className="flex items-center justify-between pb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Attack Families ({formFamilies.length} / {AttackFamily.options.length} Selected)
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAllFamilies}
                    className="text-xs text-brand hover:underline"
                  >
                    Select All
                  </button>
                  <span className="text-muted">·</span>
                  <button
                    type="button"
                    onClick={clearAllFamilies}
                    className="text-xs text-brand hover:underline"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {AttackFamily.options.map((fam) => {
                  const isChecked = formFamilies.includes(fam);
                  return (
                    <button
                      key={fam}
                      type="button"
                      onClick={() => toggleFamily(fam)}
                      className={cx(
                        "rounded-xl border px-3 py-1.5 text-xs font-semibold capitalize transition",
                        isChecked
                          ? "border-brand bg-brand text-white shadow-sm"
                          : "border-line bg-panel text-muted hover:border-brand/40 hover:text-ink",
                      )}
                    >
                      {isChecked ? "✓ " : "+ "}
                      {fam}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target Arm & Immune Learning */}
            <div className="grid gap-6 border-t border-line pt-4 sm:grid-cols-2">
              {/* Target Arm */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  Fitness Target Arm
                </label>
                <p className="mt-0.5 text-xs text-muted">
                  Which firewall arm determines attacker reward and CAPTURE fitness:
                </p>
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setFormTarget("static")}
                    className={cx(
                      "flex-1 rounded-xl border p-2.5 text-left text-xs font-medium transition",
                      formTarget === "static"
                        ? "border-brand bg-brand/10 font-bold text-brand ring-2 ring-brand"
                        : "border-line bg-panel hover:bg-line/20",
                    )}
                  >
                    <div className="text-sm font-semibold">Static Arm</div>
                    <div className="text-[11px] text-muted">Baseline frozen firewall rules</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormTarget("immune")}
                    className={cx(
                      "flex-1 rounded-xl border p-2.5 text-left text-xs font-medium transition",
                      formTarget === "immune"
                        ? "border-brand bg-brand/10 font-bold text-brand ring-2 ring-brand"
                        : "border-line bg-panel hover:bg-line/20",
                    )}
                  >
                    <div className="text-sm font-semibold">Immune Arm</div>
                    <div className="text-[11px] text-muted">Active adaptive defender memory</div>
                  </button>
                </div>
              </div>

              {/* Immune Learning Toggle */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  Defender Immune Learning
                </label>
                <p className="mt-0.5 text-xs text-muted">
                  Mint new structural antibodies and bump defender version from reported trial
                  violations:
                </p>
                <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-panel p-2.5">
                  <input
                    type="checkbox"
                    checked={formImmuneLearning}
                    onChange={(e) => setFormImmuneLearning(e.target.checked)}
                    className="h-4 w-4 rounded accent-brand"
                  />
                  <div>
                    <div className="text-xs font-semibold">
                      {formImmuneLearning
                        ? "Immune Learning Active (Adaptive)"
                        : "Learning Disabled (Frozen)"}
                    </div>
                    <div className="text-[11px] text-muted">
                      {formImmuneLearning
                        ? "Firewall synthesizes antibodies on bypassed orders"
                        : "Defender remains static for ablation benchmarking"}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Launch Action Button & Alerts */}
            {launchError && (
              <div className="rounded-lg bg-void/10 p-3 text-xs text-void">{launchError}</div>
            )}
            {launchSuccess && (
              <div className="rounded-lg bg-capture/10 p-3 text-xs font-semibold text-capture">
                {launchSuccess}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setShowLauncher(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={launching} variant="primary">
                {launching ? (
                  <>
                    <Spinner /> Launching Run...
                  </>
                ) : (
                  "Start Evolution Run"
                )}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading && !runDetail ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Big Counters Strip */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {/* Generation Counter */}
            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Generation
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-black text-brand">Gen {curGen}</span>
                <span className="text-xs text-muted">/ {maxGen}</span>
              </div>
              <div className="mt-2 text-[11px] text-muted">
                Status: <span className="font-semibold text-ink">{activeStatus}</span>
              </div>
            </Card>

            {/* Coverage Counter */}
            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                MAP-Elites Coverage
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-black text-brand">{filledCount}</span>
                <span className="text-xs text-muted">/ {ARCHIVE_CELL_COUNT} cells</span>
              </div>
              <div className="mt-2 text-[11px] text-muted">
                {coveragePercent}% of search space explored
              </div>
            </Card>

            {/* Best Fitness Counter */}
            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Best Fitness
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className={cx(
                    "text-3xl font-black",
                    bestFitness > 1.0 ? "text-rose-600 dark:text-rose-400" : "text-brand",
                  )}
                >
                  {bestFitness.toFixed(2)}
                </span>
                <Pill tone={bestFitness > 1.0 ? "bad" : "neutral"}>
                  {bestFitness > 1.0 ? "Beats Verifier" : "Under Baseline"}
                </Pill>
              </div>
              <div className="mt-2 text-[11px] text-muted">
                {bestFitness > 1.0
                  ? "Target firewall bypassed (CAPTURE)"
                  : "Attacks currently contained"}
              </div>
            </Card>

            {/* Live Cost vs Budget Counter */}
            <Card>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Live Cost vs Budget
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-black text-ink">${currentCost.toFixed(2)}</span>
                <span className="text-xs text-muted">/ ${maxBudget.toFixed(2)}</span>
              </div>
              {/* Progress bar */}
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-line/60">
                <div
                  className="h-full rounded-full bg-brand transition-all duration-300"
                  style={{ width: `${costPct}%` }}
                />
              </div>
            </Card>
          </div>

          {/* MAP-Elites Heat-Map */}
          <Card
            title={
              <div className="flex w-full items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold">MAP-Elites Archive Heat-Map</span>
                  <Pill tone="brand">7 Families × 6 Channels (42 Cells)</Pill>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded bg-zinc-200 dark:bg-zinc-800" />
                    <span className="text-muted">Empty</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded bg-sky-200 dark:bg-sky-900" />
                    <span className="text-muted">&lt; 0.5 Cool</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded bg-amber-200 dark:bg-amber-900" />
                    <span className="text-muted">0.5-1.0 Amber</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded bg-rose-300 dark:bg-rose-900" />
                    <span className="font-semibold text-rose-600 dark:text-rose-400">
                      &gt; 1.0 Red (Beats Verifier)
                    </span>
                  </span>
                </div>
              </div>
            }
          >
            <p className="mb-4 text-xs text-muted">
              Quality-diversity grid. Cell color indicates elite fitness. Cells flash when an
              operator replaces the niche elite. Click any occupied cell to inspect its evolved
              lineage and word-level diff.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-panel/50">
                    <th className="p-2.5 font-semibold">Family \ Channel</th>
                    {Channel.options.map((ch) => (
                      <th
                        key={ch}
                        className="p-2.5 font-semibold uppercase tracking-wider text-muted"
                      >
                        {ch.replace("_", " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {AttackFamily.options.map((fam) => (
                    <tr key={fam} className="hover:bg-line/20">
                      <td className="p-2.5 font-medium capitalize text-ink">{fam}</td>
                      {Channel.options.map((ch) => {
                        const cellKey = `${fam}|${ch}`;
                        const cell = cellStateMap.get(cellKey);
                        const hasElite =
                          cell && cell.eliteGenomeId !== null && cell.eliteFitness !== null;
                        const fitness = cell?.eliteFitness ?? 0;
                        const isFlashing = flashingCells.has(cellKey);

                        // Find elite genome for strategy tooltip
                        const eliteGenome = hasElite
                          ? genomes.find((g) => g.id === cell!.eliteGenomeId)
                          : null;

                        // Color rules: empty = grey, <0.5 cool, 0.5-1 amber, >1 red
                        const colorClass = !hasElite
                          ? "bg-zinc-100 dark:bg-zinc-800/40 text-muted/40 border-line/50"
                          : fitness > 1.0
                            ? "bg-rose-100 dark:bg-rose-950/50 text-rose-800 dark:text-rose-200 border-rose-300 dark:border-rose-700 font-bold ring-1 ring-rose-400/60"
                            : fitness >= 0.5
                              ? "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800"
                              : "bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800";

                        const tooltip = hasElite
                          ? `${fam.toUpperCase()} · ${ch.replace("_", " ").toUpperCase()}\nFitness: ${fitness.toFixed(2)} (W/A: ${cell!.wins}/${cell!.attempts})\nStrategy: "${eliteGenome?.strategy ?? "Evolved attack variant"}"\n\nClick to inspect lineage & word diff.`
                          : `${fam} · ${ch.replace("_", " ")}\nUnoccupied cell (${cell?.attempts ?? 0} attempts)`;

                        return (
                          <td
                            key={ch}
                            onClick={() => {
                              if (cell?.eliteGenomeId) {
                                setSelectedGenomeId(cell.eliteGenomeId);
                              }
                            }}
                            title={tooltip}
                            className={cx(
                              "border p-2.5 transition-all duration-200",
                              colorClass,
                              hasElite &&
                                "cursor-pointer hover:brightness-95 dark:hover:brightness-110",
                              isFlashing &&
                                "scale-105 animate-pulse ring-4 ring-amber-400 shadow-lg z-10 duration-700",
                            )}
                          >
                            {hasElite ? (
                              <div>
                                <div className="flex items-center justify-between">
                                  <span className="font-bold">Fit: {fitness.toFixed(2)}</span>
                                  {fitness > 1.0 && (
                                    <span className="text-[10px] text-rose-600 dark:text-rose-400">
                                      ★
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-[10px] opacity-80">
                                  W/A: {cell!.wins}/{cell!.attempts}
                                </div>
                              </div>
                            ) : (
                              <div className="text-[11px] opacity-60">
                                {cell && cell.attempts > 0 ? `Att: ${cell.attempts}` : "--"}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ASR Trajectory per Generation */}
          <Card
            title={
              <div className="flex w-full items-center justify-between">
                <span className="font-bold">
                  ASR Progression per Generation (POI-static vs POI+Immune)
                </span>
                <Pill tone="brand">{displayGenerations.length} Generations Recorded</Pill>
              </div>
            }
          >
            <p className="mb-4 text-xs text-muted">
              Attack Success Rate (ASR) tracking: POI-static (frozen baseline) versus POI+Immune
              (continuous antibody synthesis). Markers on the immune curve highlight defender
              version increments.
            </p>

            <AsrChart generations={displayGenerations} />
          </Card>

          {/* Evolved Genomes AG Grid */}
          <Card
            title={
              <div className="flex flex-wrap w-full items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-bold">Evolved Attack Genomes Catalog</span>
                  <Pill tone="brand">{genomes.length} Genomes</Pill>
                </div>

                {/* Quick Filter Input */}
                <div className="flex items-center gap-2">
                  <label className="text-xs font-semibold text-muted">Search:</label>
                  <input
                    type="text"
                    value={quickFilter}
                    onChange={(e) => setQuickFilter(e.target.value)}
                    placeholder="Quick filter (e.g. injection, subscription, mutate, 4K)..."
                    className="w-72 rounded-xl border border-line bg-panel px-3 py-1 text-xs font-medium"
                  />
                  {quickFilter && (
                    <button
                      onClick={() => setQuickFilter("")}
                      className="text-xs text-muted hover:text-ink"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            }
          >
            <p className="mb-3 text-xs text-muted">
              Click any genome row to open the lineage drawer with word-level payload diff against
              its parent.
            </p>

            <Grid
              columnDefs={columnDefs}
              rowData={genomes}
              quickFilterText={quickFilter}
              onRowClicked={(e: RowClickedEvent<GenomeRow>) => {
                if (e.data?.id) setSelectedGenomeId(e.data.id);
              }}
              height={500}
            />
          </Card>

          {/* Live Trial Feed (Streaming from arena:{runId}) */}
          <Card
            title={
              <div className="flex w-full items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold">Live Trial Stream</span>
                  <Pill tone={connected ? "good" : "neutral"}>
                    {connected ? `Streaming arena:${activeRunId}` : "Offline"}
                  </Pill>
                </div>
                <span className="font-mono text-xs text-muted">
                  {displayedTrials.length} events logged
                </span>
              </div>
            }
          >
            {displayedTrials.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <div className="h-3 w-3 animate-ping rounded-full bg-brand" />
                <p className="mt-3 text-sm font-medium">
                  Listening for live trial events on room arena:{activeRunId}...
                </p>
                <p className="mt-1 text-xs text-muted">
                  Trials appear here in real-time as workers test attack variants in Bazaar
                  sandboxes.
                </p>
              </div>
            ) : (
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {displayedTrials.map((t, idx) => (
                  <div
                    key={`${t.genomeId}-${idx}`}
                    onClick={() => setSelectedGenomeId(t.genomeId)}
                    className="flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel/40 p-3 text-xs transition hover:bg-panel"
                  >
                    {/* Left: Gen, Genome ID, Cell */}
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-brand">Gen {t.generation}</span>
                      <span className="font-mono text-muted">{t.genomeId}</span>
                      <Pill tone="brand">{t.family}</Pill>
                      <span className="rounded bg-line/40 px-1.5 py-0.5 text-[11px] font-medium text-muted">
                        {t.channel}
                      </span>
                      {t.replacedElite && (
                        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-500">
                          ★ New Elite
                        </span>
                      )}
                    </div>

                    {/* Right: Poison status, Verdict Badges, Fitness */}
                    <div className="flex items-center gap-4">
                      <span
                        className={cx("font-medium", t.chosenPoison ? "text-void" : "text-muted")}
                      >
                        {t.chosenPoison ? "Poison Chosen" : "Honest/Avoided"}
                      </span>

                      {/* Two Verdict Badges */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted">Static:</span>
                        <VerdictBadge verdict={t.verdictStatic} />
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted">Immune:</span>
                        <VerdictBadge verdict={t.verdictImmune} />
                      </div>

                      {/* Fitness Score */}
                      <div className="rounded-lg bg-brand/10 px-2.5 py-1 font-mono font-bold text-brand">
                        Fit: {t.fitness.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Lineage Drawer */}
      {selectedGenomeId && (
        <LineageDrawer genomeId={selectedGenomeId} onClose={() => setSelectedGenomeId(null)} />
      )}
    </div>
  );
}
