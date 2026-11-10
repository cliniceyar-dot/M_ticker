import { createHash } from "node:crypto";
import type { BullBearAnalysis, ResearchArgument, ResearchEvidence, ResearchSource } from "../research/types";
import { BB_CONFIG, recencyFactor, SOURCE_WEIGHT } from "./config";

/**
 * Feature-spec contract for GET /api/v1/stocks/{ticker}/bull-bear (section 3).
 * Built from a stored research analysis; filtering happens here, server-side,
 * without a new LLM run.
 */

export type SourceGroup = "official" | "news" | "social";
export type SourceRefType = "sec_filing" | "company_statement" | "news" | "x" | "youtube" | "instagram";
export type Notice =
  | "FEW_BULL_ARGUMENTS"
  | "FEW_BEAR_ARGUMENTS"
  | "RECENT_MATERIAL_EVENT"
  | "PARTIAL_HISTORY"
  | "NO_SEC_SOURCE"
  | "MISSING_SOURCES"
  | "STALE_ANALYSIS";

export interface SourceRef {
  source_item_id: string;
  type: SourceRefType;
  title: string;
  url: string;
  published_at: string | null;
  excerpt: string;
}

export interface SpecArgument {
  id: string;
  side: "bull" | "bear";
  title: string;
  explanation: string;
  source_types: SourceGroup[];
  strength: "strong" | "medium" | "weak";
  strength_score: number;
  verified_against_sec: boolean;
  conflict_flag: boolean;
  /** Extra labels, e.g. "social_opinion" for arguments backed only by social sources. */
  labels: string[];
  sources: SourceRef[];
}

export interface SpecResponse {
  ticker: string;
  company_name: string;
  generated_at: string;
  version: number;
  language: "en" | "he";
  sources_scanned: number;
  missing_sources: string[];
  history_months: number;
  bull: SpecArgument[];
  bear: SpecArgument[];
  summary: string;
  notices: Notice[];
  filters: { source_types: SourceGroup[] | null; from: string | null; to: string | null };
  cost_usd?: number;
}

export interface Filters {
  source_types?: SourceGroup[] | null;
  from?: string | null; // YYYY-MM-DD
  to?: string | null; // YYYY-MM-DD
}

const CHANNEL_TYPE: Record<string, SourceRefType> = {
  sec: "sec_filing",
  strategy: "company_statement",
  news: "news",
  x: "x",
  youtube: "youtube",
  instagram: "instagram",
};
const MISSING_NAME: Record<string, string> = {
  sec: "sec",
  strategy: "company_statements",
  news: "news",
  x: "x",
  youtube: "youtube",
  instagram: "instagram",
};

export function groupOf(type: SourceRefType): SourceGroup {
  return type === "sec_filing" || type === "company_statement" ? "official" : type === "news" ? "news" : "social";
}

/** Deterministic UUID-shaped id (stable across reads of the same version). */
export function stableId(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function capWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : `${words.slice(0, max).join(" ")}…`;
}

function inRange(published: string | null, f: Filters): boolean {
  if (!f.from && !f.to) return true;
  if (!published) return false;
  const d = published.slice(0, 10);
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  return true;
}

export function strengthFrom(sources: SourceRef[], at: Date): { score: number; level: SpecArgument["strength"]; socialOnly: boolean } {
  const score = sources.reduce((s, x) => s + SOURCE_WEIGHT[groupOf(x.type)] * recencyFactor(x.published_at, at), 0);
  const socialOnly = sources.length > 0 && sources.every((x) => groupOf(x.type) === "social");
  let level: SpecArgument["strength"] = score >= BB_CONFIG.strongThreshold ? "strong" : score >= BB_CONFIG.mediumThreshold ? "medium" : "weak";
  if (socialOnly) level = "weak"; // social-only arguments are capped at Weak
  return { score: Math.round(score * 10) / 10, level, socialOnly };
}

function toArgument(
  a: ResearchArgument,
  side: "bull" | "bear",
  analysis: BullBearAnalysis,
  srcById: Map<string, ResearchSource>,
  evById: Map<string, ResearchEvidence>,
  conflictEvidence: Set<string>,
  f: Filters,
): SpecArgument | null {
  const generated = new Date(analysis.completed_at ?? analysis.created_at);
  const evidence = a.evidence_ids.map((id) => evById.get(id)).filter(Boolean) as ResearchEvidence[];
  const refs: SourceRef[] = [];
  for (const sid of a.source_ids) {
    const s = srcById.get(sid);
    if (!s) continue;
    const type = CHANNEL_TYPE[s.channel] ?? "news";
    if (f.source_types?.length && !f.source_types.includes(groupOf(type))) continue;
    if (!inRange(s.published_at, f)) continue;
    const ev = evidence.find((e) => e.source_ids.includes(sid));
    refs.push({
      source_item_id: stableId(s.url),
      type,
      title: s.title,
      url: s.url,
      published_at: s.published_at,
      excerpt: (ev?.claim ?? s.title).slice(0, BB_CONFIG.excerptMaxChars),
    });
  }
  if (!refs.length) return null; // every argument needs at least one (visible) source
  const { score, level, socialOnly } = strengthFrom(refs, generated);
  const groups = [...new Set(refs.map((r) => groupOf(r.type)))] as SourceGroup[];
  return {
    id: stableId(analysis.analysis_id, a.id),
    side,
    title: capWords(a.title, BB_CONFIG.titleMaxWords),
    explanation: a.explanation,
    source_types: (["official", "news", "social"] as SourceGroup[]).filter((g) => groups.includes(g)),
    strength: level,
    strength_score: score,
    verified_against_sec: evidence.some((e) => e.channel === "sec"),
    conflict_flag: a.counter_evidence_ids.length > 0 || a.evidence_ids.some((id) => conflictEvidence.has(id)),
    labels: socialOnly ? ["social_opinion"] : [],
    sources: refs,
  };
}

export function toSpecResponse(
  analysis: BullBearAnalysis,
  version: number,
  filters: Filters = {},
  opts: { stale?: boolean; now?: Date } = {},
): SpecResponse {
  const now = opts.now ?? new Date();
  const srcById = new Map(analysis.sources.map((s) => [s.id, s]));
  const evById = new Map(analysis.evidence.map((e) => [e.id, e]));
  const conflictEvidence = new Set(analysis.conflicts.flatMap((c) => c.evidence_ids));
  const build = (args: ResearchArgument[], side: "bull" | "bear") =>
    args
      .map((a) => toArgument(a, side, analysis, srcById, evById, conflictEvidence, filters))
      .filter(Boolean)
      .sort((x, y) => y!.strength_score - x!.strength_score)
      .slice(0, BB_CONFIG.maxArgumentsPerSide) as SpecArgument[];
  const bull = build(analysis.bullish_arguments, "bull");
  const bear = build(analysis.bearish_arguments, "bear");

  const missing = analysis.coverage
    .filter((c) => c.requested && (c.status === "unavailable" || c.status === "error"))
    .map((c) => MISSING_NAME[c.channel] ?? c.channel);
  const historyMonths = analysis.history_months ?? analysis.options.company_history_months;
  const notices: Notice[] = [];
  if (bull.length < BB_CONFIG.minArgumentsPerSide) notices.push("FEW_BULL_ARGUMENTS");
  if (bear.length < BB_CONFIG.minArgumentsPerSide) notices.push("FEW_BEAR_ARGUMENTS");
  if (analysis.recent_material_event_at && now.getTime() - Date.parse(analysis.recent_material_event_at) <= 24 * 3600e3)
    notices.push("RECENT_MATERIAL_EVENT");
  if (historyMonths < analysis.options.company_history_months) notices.push("PARTIAL_HISTORY");
  if (missing.includes("sec")) notices.push("NO_SEC_SOURCE");
  if (missing.length) notices.push("MISSING_SOURCES");
  if (opts.stale) notices.push("STALE_ANALYSIS");

  return {
    ticker: analysis.ticker,
    company_name: analysis.company_name ?? analysis.ticker,
    generated_at: analysis.completed_at ?? analysis.created_at,
    version,
    language: analysis.options.language ?? "en",
    sources_scanned: analysis.sources_scanned ?? analysis.sources.length,
    missing_sources: missing,
    history_months: historyMonths,
    bull,
    bear,
    summary: analysis.summary ?? "",
    notices,
    filters: { source_types: filters.source_types?.length ? filters.source_types : null, from: filters.from ?? null, to: filters.to ?? null },
    cost_usd: analysis.cost_usd,
  };
}

export function parseFilters(params: URLSearchParams): Filters | { error: string } {
  const st = params.get("source_types");
  const types = st ? st.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : [];
  if (types.some((t) => !["official", "news", "social"].includes(t))) return { error: "source_types must be a comma list of official, news, social" };
  const date = (k: string) => {
    const v = params.get(k);
    if (!v) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  };
  const from = date("from");
  const to = date("to");
  if (from === undefined || to === undefined) return { error: "from/to must be YYYY-MM-DD" };
  if (from && to && from > to) return { error: "from must be on or before to" };
  return { source_types: types.length ? (types as SourceGroup[]) : null, from, to };
}
