import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CATALYST_CATEGORIES, type CatalystCategory, type Classification, type Evidence, type InsiderAnalysis, type MarketContext } from "./types";
import { midStrength, BASE_STRENGTH } from "./taxonomy";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-opus-5-5";
export const SKILL_VERSION = "catalyst-classifier@0.1.0";

const HOUR = 3600_000;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// ------------------------------------------------------------------
// Deterministic rules engine (always available; also the fallback)
// ------------------------------------------------------------------

function textOf(e: Evidence) {
  return `${e.headline}\n${e.excerpt ?? ""}`.toLowerCase();
}

function ruleCategory(e: Evidence, m: MarketContext): { cat: CatalystCategory; novelty: number; certainty: number; nm: Classification["new_or_materialization"]; note?: string } {
  const t = textOf(e);
  if (e.source_type === "FDA") return { cat: "FDA_APPROVAL", novelty: 85, certainty: 95, nm: "MIXED" };
  const form = e.form ?? "";
  if (/^(SC TO-T|SC 14D9|SC TO-C|425|DEFM14A|PREM14A)/.test(form))
    return { cat: "M&A_OFFER", novelty: 80, certainty: 85, nm: "NEW" };
  const items = e.items ?? [];
  if (/fda (has )?(approv|grant)|approval (of|from) the (u\.s\. )?food and drug/.test(t)) return { cat: "FDA_APPROVAL", novelty: 85, certainty: 90, nm: "MIXED" };
  if (/topline|top-line|primary endpoint|phase (2|3|ii|iii)\b.*(met|achiev|positive)/.test(t)) return { cat: "FDA_TRIAL_RESULT", novelty: 90, certainty: 85, nm: "NEW" };
  if (/definitive (merger )?agreement to (be )?acqui|tender offer|to be acquired by|per share in cash/.test(t)) return { cat: "M&A_OFFER", novelty: 90, certainty: 85, nm: "NEW" };
  if (items.includes("2.02")) {
    const raise = /(rais|increas)(es|ed|ing)? (its |our |the )?(full[- ]year |fiscal (year )?(20\d\d )?|annual |fy ?(20)?\d\d )?(revenue |sales |earnings |eps )?(guidance|outlook)/.test(t);
    if (raise) return { cat: "EARNINGS_GUIDANCE_RAISE", novelty: 85, certainty: 95, nm: "NEW" };
    const up = (m.stock_move_pct ?? 0) > Math.max(3, 1.5 * (m.atr_pct ?? 2));
    const down = (m.stock_move_pct ?? 0) < -Math.max(3, 1.5 * (m.atr_pct ?? 2));
    if (up) return { cat: "EARNINGS_POSITIVE_SURPRISE", novelty: 75, certainty: 90, nm: "NEW", note: "Beat inferred from price reaction; numbers not parsed by rules engine." };
    return { cat: "EARNINGS_MIXED", novelty: 60, certainty: 90, nm: "NEW", note: down ? "Negative price reaction to results." : "Results released; direction unclear without classifier." };
  }
  if (items.includes("1.01")) {
    if (/(collaborat|partnership|licens)/.test(t)) return { cat: "PARTNERSHIP", novelty: 75, certainty: 90, nm: "NEW" };
    if (/(credit agreement|indenture|notes due|term loan|revolving)/.test(t)) return { cat: "DEBT_REFINANCING", novelty: 40, certainty: 90, nm: "NEW" };
    if (/merger|acqui/.test(t)) return { cat: "M&A_OFFER", novelty: 85, certainty: 85, nm: "NEW" };
    return { cat: "MAJOR_CONTRACT", novelty: 70, certainty: 90, nm: "NEW" };
  }
  if (items.includes("2.01")) return { cat: "M&A_COMPLETION", novelty: 25, certainty: 95, nm: "MATERIALIZATION" };
  if (/repurchase|buyback/.test(t)) return { cat: "BUYBACK", novelty: 60, certainty: 90, nm: "NEW" };
  if (/special dividend|increase(s|d)? (its |the )?(quarterly )?dividend/.test(t)) return { cat: "CAPITAL_RETURN", novelty: 55, certainty: 90, nm: "NEW" };
  if (/s&p (500|midcap 400|smallcap 600)|added to the .* index/.test(t)) return { cat: "INDEX_INCLUSION", novelty: 80, certainty: 85, nm: "NEW" };
  if (items.includes("5.02")) return { cat: "MANAGEMENT_CHANGE", novelty: 50, certainty: 95, nm: "NEW" };
  if (/court|jury|verdict|settle|patent|ruling/.test(t)) return { cat: "LEGAL_REGULATORY_WIN", novelty: 70, certainty: 75, nm: "NEW" };
  return { cat: "KNOWN_EVENT_MATERIALIZATION", novelty: 35, certainty: 85, nm: "MATERIALIZATION" };
}

const LOW_SIGNAL_8K = (e: Evidence) =>
  (e.form ?? "").startsWith("8-K") && (e.items ?? []).every((i) => ["5.07", "9.01", "5.03", "3.02", "7.01"].includes(i));

export function noNewsClassification(m: MarketContext, insider: InsiderAnalysis, engine: "rules" | "claude" = "rules"): Classification {
  const sectorMove = m.sector_move_pct ?? 0;
  const rel = m.relative_return_to_sector ?? 0;
  const sympathy = Math.abs(sectorMove) >= 1.5 && Math.abs(rel) < Math.max(2, Math.abs(sectorMove));
  const drivers = ["technical breakout", "sector move", "positioning / short squeeze", "flow-driven move"];
  return {
    engine,
    category: sympathy ? "SECTOR_SYMPATHY" : "NO_IDENTIFIABLE_NEWS",
    headline: sympathy
      ? `Move tracks sector ETF ${m.sector_etf} (${sectorMove.toFixed(1)}%) — no company-specific filing found`
      : "No fresh company-specific source found in the window",
    event_time: null,
    new_or_materialization: "UNKNOWN",
    novelty_score: 0,
    materiality_score: sympathy ? 30 : 10,
    surprise: 0,
    credibility: 0,
    certainty: 0,
    catalyst_strength: sympathy ? 8 : 2,
    secondary_catalysts: insider.signal === "POSITIVE" ? ["INSIDER_BUYING"] : [],
    evidence_ids: [],
    conflicts: [],
    high_authority_conflict: false,
    causal_attribution: "LOW",
    possible_drivers: drivers,
    reasoning_summary:
      "No official filing or FDA action within the freshness window explains the move. Any probability rests on price/volume/context only, not on fundamental information.",
    main_risk: "Causal attribution is low — the move may reverse without a fundamental anchor.",
  };
}

export function classifyWithRules(evidence: Evidence[], m: MarketContext, insider: InsiderAnalysis, asOf: Date, windowHours: number): Classification {
  const fresh = evidence.filter((e) => asOf.getTime() - Date.parse(e.first_public_timestamp) <= windowHours * HOUR && !LOW_SIGNAL_8K(e));
  if (!fresh.length) return noNewsClassification(m, insider);
  // rank: strongest base category first, then newest
  const ranked = fresh
    .map((e) => ({ e, r: ruleCategory(e, m) }))
    .sort((a, b) => midStrength(b.r.cat) - midStrength(a.r.cat) || b.e.first_public_timestamp.localeCompare(a.e.first_public_timestamp));
  const top = ranked[0];
  const [lo, hi] = BASE_STRENGTH[top.r.cat];
  return {
    engine: "rules",
    category: top.r.cat,
    headline: top.e.headline,
    event_time: top.e.first_public_timestamp,
    new_or_materialization: top.r.nm,
    novelty_score: top.r.novelty,
    materiality_score: clamp(midStrength(top.r.cat) * 4, 0, 100),
    surprise: top.r.novelty * 0.8,
    credibility: top.e.source_type === "SEC_FILING" || top.e.source_type === "FDA" ? 95 : 60,
    certainty: top.r.certainty,
    catalyst_strength: (lo + hi) / 2,
    secondary_catalysts: Array.from(new Set(ranked.slice(1, 4).map((x) => x.r.cat).filter((c) => c !== top.r.cat))),
    evidence_ids: [top.e.id, ...ranked.slice(1, 3).map((x) => x.e.id)],
    conflicts: [],
    high_authority_conflict: false,
    causal_attribution: "MEDIUM",
    possible_drivers: [],
    reasoning_summary: `Deterministic classification from ${top.e.source_name}${top.e.items?.length ? ` (items ${top.e.items.join(", ")})` : ""}. ${top.r.note ?? ""}`.trim(),
    main_risk: "Rules engine cannot read magnitudes (beat size, guidance delta); set ANTHROPIC_API_KEY for the Claude classifier.",
    note: top.r.note,
  };
}

// ------------------------------------------------------------------
// Claude classification layer (structured outputs)
// ------------------------------------------------------------------

const ClaudeOut = z.object({
  category: z.enum(CATALYST_CATEGORIES),
  headline: z.string(),
  primary_evidence_id: z.string(),
  supporting_evidence_ids: z.array(z.string()),
  new_or_materialization: z.enum(["NEW", "MATERIALIZATION", "MIXED", "UNKNOWN"]),
  novelty_score: z.number(),
  materiality_score: z.number(),
  surprise: z.number(),
  credibility: z.number(),
  certainty: z.number(),
  catalyst_strength: z.number(),
  secondary_catalysts: z.array(z.enum(CATALYST_CATEGORIES)),
  conflicts: z.array(z.string()),
  high_authority_conflict: z.boolean(),
  causal_attribution: z.enum(["HIGH", "MEDIUM", "LOW"]),
  possible_drivers: z.array(z.string()),
  reasoning_summary: z.string(),
  main_risk: z.string(),
});

const SYSTEM = `You are the Catalyst Classifier inside an event-intelligence system for equity traders.
Your job: given ONLY the evidence documents supplied, identify the single primary catalyst behind the stock's current move and score it.

Hard rules (anti-hallucination):
- Never invent a catalyst. Every claim must come from a supplied evidence document; cite it by id.
- Never infer earnings numbers that are not in the text. Never state an FDA approval unless an FDA document or the company filing states it.
- Never classify a Form 4 award/exercise as an open-market purchase.
- Ignore anything dated after as_of (none should be supplied).
- If no supplied evidence explains the move, return category NO_IDENTIFIABLE_NEWS, primary_evidence_id "none", causal_attribution LOW and list possible_drivers.
- If two high-authority sources materially disagree, set high_authority_conflict true and category CONFLICTING_INFORMATION.
- If causal attribution is uncertain, say so.

Scoring guidance (all 0-100 unless noted):
- novelty_score: 100 first revelation of a material fact; 85 definitive resolution of an uncertain binary event; 70 meaningful revision to a known thesis; 50 confirmation of an expected event; 30 reiteration/commentary; 10 recycled; 0 nothing new.
- materiality_score: expected impact on intrinsic value / revenue outlook.
- surprise: how much was not priced in (earnings beat + raised guidance is two-dimensional surprise).
- credibility: source authority (SEC/FDA/company filing highest).
- certainty: signed contract or approval > official report > "in talks" > rumor.
- catalyst_strength (0-25) seed ranges: cash acquisition offer at premium 24-25; unexpected FDA approval/decisive trial 22-25; earnings beat + major guidance raise 20-24; material revenue-changing contract 19-23; strategic transaction/major partnership 17-22; index addition 15-20; analyst upgrade with thesis change 10-16; price-target-only 5-10; sector sympathy 5-12; technical breakout with no news 0-8.
- new_or_materialization: NEW if genuinely new information; MATERIALIZATION if an already-known event simply happened (e.g. closing of an acquisition approved months ago).
Keep reasoning_summary to 2-4 sentences with concrete numbers drawn from the evidence. main_risk: one sentence.`;

export async function classifyWithClaude(
  evidence: Evidence[],
  m: MarketContext,
  insider: InsiderAnalysis,
  ticker: string,
  company: string,
  asOf: Date,
  windowHours: number,
): Promise<Classification> {
  const client = new Anthropic({ timeout: 55_000, maxRetries: 1 });
  const fresh = evidence.filter((e) => asOf.getTime() - Date.parse(e.first_public_timestamp) <= windowHours * HOUR * 3);
  const docs = fresh
    .slice(0, 10)
    .map(
      (e) =>
        `<evidence id="${e.id}" source_type="${e.source_type}" source="${e.source_name}" first_public="${e.first_public_timestamp}" url="${e.source_url}">\n${e.headline}\n${e.excerpt ? e.excerpt.slice(0, 7000) : ""}\n</evidence>`,
    )
    .join("\n\n");
  const fmt = (x: number | null, d = 2, suf = "") => (x === null ? "n/a" : `${x.toFixed(d)}${suf}`);
  const marketBlock = m.available
    ? `stock_move_pct=${fmt(m.stock_move_pct)} gap_pct=${fmt(m.stock_gap_pct)} sector_etf=${m.sector_etf} sector_move_pct=${fmt(m.sector_move_pct)} SPY=${fmt(m.spy_move_pct)} QQQ=${fmt(m.qqq_move_pct)} relative_to_sector=${fmt(m.relative_return_to_sector)} RVOL=${fmt(m.relative_volume)}x ATR%=${fmt(m.atr_pct)} gap_vs_ATR=${fmt(m.gap_vs_atr)} bar_date=${m.bar_date}`
    : "market data unavailable";
  const insiderBlock = `signal=${insider.signal} score=${insider.score} ${insider.score_breakdown.map((b) => `${b.label} (${b.points})`).join("; ")}`;
  const user = `ticker: ${ticker} (${company})
as_of: ${asOf.toISOString()}
freshness window: ${windowHours}h (older evidence is context only)

<market_context>${marketBlock}</market_context>
<insider_summary>${insiderBlock}</insider_summary>

${docs || "<no_evidence>No filings, FDA actions or releases were found in the window.</no_evidence>"}

Classify the primary catalyst.`;

  const response = await client.beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(ClaudeOut) },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined the request");
  const out = response.parsed_output;
  if (!out) throw new Error("Claude returned no parseable output");

  const ids = new Set(evidence.map((e) => e.id));
  const cited = [out.primary_evidence_id, ...out.supporting_evidence_ids].filter((id) => ids.has(id));
  const primary = evidence.find((e) => e.id === out.primary_evidence_id);

  // Anti-hallucination gate: a fundamental catalyst must cite a real evidence document.
  const needsEvidence = !["NO_IDENTIFIABLE_NEWS", "SECTOR_SYMPATHY", "MACRO_SYMPATHY", "TECHNICAL_ONLY", "SHORT_SQUEEZE_LIKELY", "CONFLICTING_INFORMATION"].includes(out.category);
  if (needsEvidence && !primary) {
    const c = noNewsClassification(m, insider, "claude");
    c.model = response.model;
    c.note = `Claude proposed ${out.category} without a valid evidence citation; suppressed by anti-hallucination rule.`;
    return c;
  }
  const [lo, hi] = BASE_STRENGTH[out.category];
  return {
    engine: "claude",
    model: response.model,
    category: out.category,
    headline: out.headline,
    event_time: primary?.first_public_timestamp ?? null,
    new_or_materialization: out.new_or_materialization,
    novelty_score: clamp(out.novelty_score, 0, 100),
    materiality_score: clamp(out.materiality_score, 0, 100),
    surprise: clamp(out.surprise, 0, 100),
    credibility: clamp(out.credibility, 0, 100),
    certainty: clamp(out.certainty, 0, 100),
    catalyst_strength: clamp(out.catalyst_strength, lo, hi),
    secondary_catalysts: out.secondary_catalysts.filter((c) => c !== out.category),
    evidence_ids: Array.from(new Set(cited)),
    conflicts: out.conflicts,
    high_authority_conflict: out.high_authority_conflict,
    causal_attribution: out.causal_attribution,
    possible_drivers: out.possible_drivers,
    reasoning_summary: out.reasoning_summary,
    main_risk: out.main_risk,
  };
}
