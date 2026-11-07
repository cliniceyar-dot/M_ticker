import type { AnalystOutput, DraftArgument } from "./analysts";
import type { Level, ResearchArgument, ResearchConflict, ResearchEvidence, ResearchSource, Verification } from "./types";

/**
 * Skill 6 — Evidence Validator & Report Composer (deterministic).
 * - drops citations to unknown evidence and arguments left without evidence
 * - counts independent EVENTS (not articles) so repeated coverage can't inflate strength
 * - scores evidence strength from verification quality, corroboration and counter-evidence
 * - merges duplicate arguments, flags stale ones, ranks by materiality × strength
 * - surfaces conflicts (analyst-reported + same event reported in opposite directions)
 */

const LV: Record<Level, number> = { low: 1, medium: 2, high: 3 };
const fromNum = (n: number): Level => (n >= 3 ? "high" : n >= 2 ? "medium" : "low");
const VER_BASE: Record<Verification, number> = {
  confirmed_fact: 3,
  management_statement: 2,
  analyst_interpretation: 1.5,
  opinion: 1,
  speculation: 0.5,
};
const OFFICIAL = new Set(["sec", "strategy"]);

export function evidenceStrength(items: ResearchEvidence[], counter: ResearchEvidence[]): { level: Level; independent: number } {
  if (!items.length) return { level: "low", independent: 0 };
  const independent = new Set(items.map((e) => e.event_key)).size;
  let score = Math.max(...items.map((e) => VER_BASE[e.verification]));
  const official = items.some((e) => OFFICIAL.has(e.channel) && e.verification === "confirmed_fact");
  if (independent >= 2 && (official || score >= 2)) score += 1; // corroborated by a distinct event
  if (items.every((e) => e.verification === "speculation" || e.verification === "opinion")) score = Math.min(score, 1);
  score = Math.min(score, 3); // corroboration can't absorb counter-evidence
  if (counter.length) score -= 1;
  return { level: fromNum(Math.round(score)), independent };
}

function jaccard(a: string[], b: string[]) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);

export function composeSide(
  side: "bullish" | "bearish",
  drafts: DraftArgument[],
  evidence: ResearchEvidence[],
  asOf: Date,
  warnings: string[],
): ResearchArgument[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const cleaned = drafts
    .map((d) => ({ ...d, evidence_ids: [...new Set(d.evidence_ids.filter((id) => byId.has(id)))], counter_evidence_ids: [...new Set(d.counter_evidence_ids.filter((id) => byId.has(id)))] }))
    .filter((d) => d.evidence_ids.length > 0);
  const dropped = drafts.length - cleaned.length;
  if (dropped) warnings.push(`${dropped} ${side} argument(s) removed: no verifiable evidence citation.`);

  // merge duplicates (same evidence or near-identical titles)
  const merged: DraftArgument[] = [];
  for (const d of cleaned) {
    const dup = merged.find((m) => jaccard(m.evidence_ids, d.evidence_ids) >= 0.6 || jaccard(words(m.title), words(d.title)) >= 0.7);
    if (dup) {
      dup.evidence_ids = [...new Set([...dup.evidence_ids, ...d.evidence_ids])];
      dup.counter_evidence_ids = [...new Set([...dup.counter_evidence_ids, ...d.counter_evidence_ids])];
      if (LV[d.materiality] > LV[dup.materiality]) dup.materiality = d.materiality;
    } else merged.push({ ...d });
  }

  const out: ResearchArgument[] = merged.map((d) => {
    const items = d.evidence_ids.map((id) => byId.get(id)!);
    const counter = d.counter_evidence_ids.map((id) => byId.get(id)!);
    const { level, independent } = evidenceStrength(items, counter);
    const dates = items.map((e) => e.published_at).filter(Boolean) as string[];
    const latest = dates.sort().at(-1) ?? null;
    if (latest) {
      const ageDays = (asOf.getTime() - Date.parse(latest)) / 86400e3;
      const limit = d.time_horizon === "short_term" ? 45 : d.time_horizon === "medium_term" ? 200 : 450;
      if (ageDays > limit) warnings.push(`Stale evidence: "${d.title}" relies on information from ${latest.slice(0, 10)}.`);
    }
    return {
      id: "",
      side,
      rank: 0,
      title: d.title,
      explanation: d.explanation,
      evidence_summary: d.evidence_summary,
      evidence_ids: d.evidence_ids,
      source_ids: [...new Set(items.flatMap((e) => e.source_ids))],
      materiality: d.materiality,
      evidence_strength: level,
      time_horizon: d.time_horizon,
      latest_date: latest,
      independent_events: independent,
      verification_mix: [...new Set(items.map((e) => e.verification))],
      counter_evidence_ids: d.counter_evidence_ids,
    };
  });

  const score = (a: ResearchArgument) => LV[a.materiality] * 2 + LV[a.evidence_strength] * 2 + (a.latest_date ? Math.max(0, 1 - (asOf.getTime() - Date.parse(a.latest_date)) / (365 * 86400e3)) : 0);
  return out
    .sort((a, b) => score(b) - score(a))
    .map((a, i) => ({ ...a, rank: i + 1, id: `${side === "bullish" ? "bull" : "bear"}-${i + 1}` }));
}

export function detectConflicts(evidence: ResearchEvidence[], analystConflicts: { description: string; evidence_ids: string[] }[]): ResearchConflict[] {
  const ids = new Set(evidence.map((e) => e.id));
  const out: ResearchConflict[] = [];
  const byEvent = new Map<string, ResearchEvidence[]>();
  for (const e of evidence) byEvent.set(e.event_key, [...(byEvent.get(e.event_key) ?? []), e]);
  for (const [key, items] of byEvent) {
    const bull = items.filter((e) => e.direction === "BULLISH");
    const bear = items.filter((e) => e.direction === "BEARISH");
    if (bull.length && bear.length) {
      const officialSide = [...bull, ...bear].some((e) => OFFICIAL.has(e.channel));
      out.push({
        id: "",
        description: `Sources characterize the same event (${key.replace(/^(news|str|fin)-/, "")}) in opposite directions.`,
        evidence_ids: [...bull, ...bear].map((e) => e.id),
        resolution: officialSide ? "official_source_prevails" : "confidence_reduced",
      });
    }
  }
  for (const c of analystConflicts) {
    const evIds = c.evidence_ids.filter((id) => ids.has(id));
    if (evIds.length < 2) continue;
    if (out.some((o) => jaccard(o.evidence_ids, evIds) >= 0.6)) continue;
    out.push({ id: "", description: c.description, evidence_ids: evIds, resolution: "unresolved" });
  }
  return out.map((c, i) => ({ ...c, id: `conflict-${i + 1}` }));
}

export function compose(args: {
  bullish: AnalystOutput;
  bearish: AnalystOutput;
  evidence: ResearchEvidence[];
  sources: ResearchSource[];
  asOf: Date;
}) {
  const warnings: string[] = [];
  const bullish_arguments = composeSide("bullish", args.bullish.arguments, args.evidence, args.asOf, warnings);
  const bearish_arguments = composeSide("bearish", args.bearish.arguments, args.evidence, args.asOf, warnings);
  const conflicts = detectConflicts(args.evidence, [...args.bullish.conflicts, ...args.bearish.conflicts]);
  // keep only sources that are actually referenced
  const used = new Set(args.evidence.flatMap((e) => e.source_ids));
  const sources = args.sources.filter((s) => used.has(s.id));
  return {
    bullish_arguments,
    bearish_arguments,
    conflicts,
    sources,
    insufficient: { bullish: bullish_arguments.length === 0, bearish: bearish_arguments.length === 0 },
    warnings,
  };
}
