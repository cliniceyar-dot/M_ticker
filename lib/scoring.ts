import type { BreakoutInput, Classification, InsiderAnalysis, MarketContext, ScoreComponent, SourceType } from "./types";

export const SCORING_VERSION = "raw-score@0.1.0";
export const CALIBRATION_VERSION = "seed-logistic@0 (UNCALIBRATED — replace after backtest)";

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

const SOURCE_CERTAINTY: Record<SourceType, number> = {
  SEC_FILING: 1,
  FDA: 1,
  COMPANY_IR: 0.95,
  WIRE: 0.75,
  AGGREGATOR: 0.5,
  MARKET_DATA: 0.3,
  COMMUNITY: 0.15,
};

export function computeRawScore(args: {
  c: Classification;
  sourceType: SourceType | null;
  m: MarketContext;
  insider: InsiderAnalysis;
  hoursSinceEvent: number | null;
}): { raw: number; components: ScoreComponent[] } {
  const { c, sourceType, m, insider, hoursSinceEvent } = args;
  const comps: ScoreComponent[] = [];
  const add = (key: string, label: string, value: number, max: number, sign: 1 | -1, why: string) =>
    comps.push({ key, label, value: Math.round(clamp(value, 0, max) * 10) / 10, max, sign, why });

  add("strength", "Catalyst Strength", c.catalyst_strength, 25, 1, `${c.category} base range`);
  add("novelty", "Surprise / Novelty", ((c.novelty_score * 0.6 + c.surprise * 0.4) / 100) * 20, 20, 1, `novelty ${c.novelty_score.toFixed(0)}, surprise ${c.surprise.toFixed(0)}`);
  const srcMult = sourceType ? SOURCE_CERTAINTY[sourceType] : 0;
  add("certainty", "Information Certainty", (c.certainty / 100) * srcMult * 15, 15, 1, sourceType ? `${sourceType} × certainty ${c.certainty.toFixed(0)}` : "no source");

  // Price confirmation: is the market reacting in the catalyst's direction, scaled by ATR
  let priceConf = 0;
  let priceWhy = "no market data";
  if (m.available && m.stock_move_pct !== null) {
    const atr = Math.max(1, m.atr_pct ?? 2.5);
    priceConf = m.stock_move_pct > 0 ? (m.stock_move_pct / (2 * atr)) * 15 : 0;
    priceWhy = `move ${m.stock_move_pct.toFixed(1)}% vs ATR ${atr.toFixed(1)}%`;
  }
  add("price", "Price Confirmation", priceConf, 15, 1, priceWhy);

  let demand = 0;
  let demandWhy = "no volume data";
  if (m.relative_volume !== null) {
    demand = (m.relative_volume - 1) * 2.5;
    demandWhy = `RVOL ${m.relative_volume.toFixed(1)}x`;
  }
  add("demand", "Relative Demand", demand, 10, 1, demandWhy);

  add("insider", "Insider Confirmation", (Math.max(0, insider.score) / 12) * 5, 5, 1, `insider score ${insider.score}`);

  let indep = 0;
  let indepWhy = "no sector data";
  if (m.relative_return_to_sector !== null) {
    indep = (m.relative_return_to_sector / 5) * 5;
    indepWhy = `${m.relative_return_to_sector >= 0 ? "+" : ""}${m.relative_return_to_sector.toFixed(1)}% vs ${m.sector_etf}`;
  }
  add("independence", "Sector Independence", indep, 5, 1, indepWhy);
  add("source", "Source Confidence", srcMult * 5 * (c.credibility / 100 || 0.6), 5, 1, sourceType ?? "none");

  const contradiction = c.high_authority_conflict ? 15 : c.conflicts.length * 6;
  add("contradiction", "Contradiction Penalty", contradiction, 15, -1, c.conflicts.length ? `${c.conflicts.length} conflict(s)` : "none");

  let stale = 0;
  if (hoursSinceEvent === null) stale = 8;
  else if (hoursSinceEvent > 120) stale = 15;
  else if (hoursSinceEvent > 72) stale = 11;
  else if (hoursSinceEvent > 36) stale = 7;
  else if (hoursSinceEvent > 16) stale = 3;
  if (c.new_or_materialization === "MATERIALIZATION") stale = Math.min(15, stale + 4);
  add("staleness", "Staleness Penalty", stale, 15, -1, hoursSinceEvent === null ? "no dated catalyst" : `${hoursSinceEvent.toFixed(0)}h since first public${c.new_or_materialization === "MATERIALIZATION" ? ", materialization" : ""}`);

  const raw = clamp(comps.reduce((s, x) => s + x.sign * x.value, 0), 0, 100);
  return { raw: Math.round(raw * 10) / 10, components: comps };
}

/**
 * Seed mapping Raw Score → P(no averaging). This is a placeholder logistic curve
 * with conservative bounds until a point-in-time backtest provides an isotonic /
 * Platt calibration. It is labeled as such everywhere it is shown.
 */
export function seedProbability(raw: number, m: MarketContext, breakout: BreakoutInput | null): { p: number; basis: string } {
  let z = (raw - 55) / 12;
  const notes: string[] = [`logistic((raw−55)/12)`];
  if (breakout) {
    const adj = breakout.pattern === "PEAK" ? 0.15 : breakout.pattern === "BOTTOM" ? -0.15 : 0;
    if (adj) {
      z += adj;
      notes.push(`${breakout.pattern} pattern ${adj > 0 ? "+" : ""}${adj}`);
    }
  }
  if (m.gap_vs_atr !== null && m.gap_vs_atr > 3) {
    z -= 0.35;
    notes.push(`over-extended gap (${m.gap_vs_atr.toFixed(1)}×ATR) −0.35`);
  }
  const p = clamp(1 / (1 + Math.exp(-z)), 0.05, 0.9);
  return { p, basis: `${CALIBRATION_VERSION}: ${notes.join(", ")}` };
}

export function computeConfidence(args: {
  entityOk: boolean;
  m: MarketContext;
  filingsOk: boolean;
  c: Classification;
  sourceType: SourceType | null;
  insider: InsiderAnalysis;
}): { confidence: number; breakdown: { label: string; points: number }[] } {
  const b: { label: string; points: number }[] = [];
  if (args.entityOk) b.push({ label: "Entity resolved via SEC CIK", points: 10 });
  if (args.m.available) b.push({ label: "Market data available", points: 15 });
  if (args.m.sector_move_pct !== null) b.push({ label: "Sector benchmark available", points: 5 });
  if (args.filingsOk) b.push({ label: "SEC filings retrieved", points: 15 });
  b.push(args.c.engine === "claude" ? { label: "Claude classification of source text", points: 20 } : { label: "Rules-only classification", points: 8 });
  if (args.insider.available) b.push({ label: "Form 4 data parsed", points: 5 });
  if (args.sourceType === "SEC_FILING" || args.sourceType === "FDA") b.push({ label: "Primary source is official", points: 20 });
  else if (args.sourceType) b.push({ label: "Primary source is secondary", points: 8 });
  if (args.c.evidence_ids.length >= 2) b.push({ label: "Secondary confirmation", points: 10 });
  if (args.c.causal_attribution === "LOW") b.push({ label: "Low causal attribution", points: -20 });
  if (args.c.conflicts.length) b.push({ label: "Conflicting sources", points: -15 * Math.min(2, args.c.conflicts.length) });
  const confidence = clamp(b.reduce((s, x) => s + x.points, 0), 0, 100);
  return { confidence, breakdown: b };
}

/** Minimum probability for a positive-EV immediate entry: p* = (L + C) / (W + L). */
export function evThreshold(W: number, L: number, C: number) {
  return W + L > 0 ? (L + C) / (W + L) : 1;
}
