import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { claude, GROUNDING_RULES, languageRule, RESEARCH_MODEL, track } from "./claude";
import type { Horizon, Level, ResearchEvidence } from "./types";

/**
 * Skills 4 & 5 — Bullish and Bearish Evidence Analysts.
 * Each analyst independently reads the SAME evidence set. The bearish analyst
 * is instructed to actively test the bullish thesis, not to manufacture balance.
 */

export interface DraftArgument {
  title: string;
  explanation: string;
  evidence_summary: string;
  evidence_ids: string[];
  counter_evidence_ids: string[];
  materiality: Level;
  time_horizon: Horizon;
}

export interface DraftConflict {
  description: string;
  evidence_ids: string[];
}

export interface AnalystOutput {
  arguments: DraftArgument[];
  conflicts: DraftConflict[];
  insufficient: boolean;
}

const Out = z.object({
  arguments: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      evidence_summary: z.string(),
      evidence_ids: z.array(z.string()),
      counter_evidence_ids: z.array(z.string()),
      materiality: z.enum(["high", "medium", "low"]),
      time_horizon: z.enum(["short_term", "medium_term", "long_term"]),
    }),
  ),
  conflicts: z.array(z.object({ description: z.string(), evidence_ids: z.array(z.string()) })),
  insufficient: z.boolean(),
});

const ROLE = {
  bullish: `You are the Bullish Evidence Analyst. Identify the strongest evidence-backed arguments that the company's business performance is improving, that investor expectations may move favorably, or that the stock has further upside.`,
  bearish: `You are the Bearish Evidence Analyst. Independently examine the same evidence for business weaknesses, valuation concerns, financial and operational risks, contradictions between management statements and results, negative market developments, and weaknesses in the bullish thesis. Actively test the bullish case; do NOT invent opposing arguments to create balance — if the bearish case is weak, return few arguments or set insufficient=true.`,
};

export function evidenceDigest(evidence: ResearchEvidence[]): string {
  return evidence
    .map(
      (e) =>
        `<evidence id="${e.id}" channel="${e.channel}" date="${e.published_at ?? "unknown"}" direction="${e.direction}" verification="${e.verification}" materiality="${e.materiality}" event="${e.event_key}">${e.claim}</evidence>`,
    )
    .join("\n");
}

export async function runAnalyst(
  side: "bullish" | "bearish",
  args: { company: string; ticker: string; asOf: Date; evidence: ResearchEvidence[]; language?: "en" | "he" },
): Promise<AnalystOutput> {
  const res = await claude().beta.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(Out) },
    system: `${ROLE[side]}
${GROUNDING_RULES}
Output rules:
- Up to 7 arguments, most material first. Each: a title of one sentence and at most 15 words; a 2–4 sentence plain-language explanation of the argument and its financial significance; an evidence_summary with the key figures and dates; evidence_ids (required, from the input); counter_evidence_ids for credible evidence that challenges it.
- Several evidence records with the same "event" value are one underlying event, not independent confirmation.
- Prefer official filings and company documents for facts; use news and social items for context and narrative, labelled as such.
- Report material disagreements between sources in conflicts.
- Use neutral, factual tone: no loaded words such as "brilliant", "collapsing", "disaster".
- Set insufficient=true when the evidence does not support any credible ${side} argument.
- ${languageRule(args.language)}`,
    messages: [{ role: "user", content: `Company: ${args.company} (${args.ticker}). Decision time: ${args.asOf.toISOString()}.\n\n${evidenceDigest(args.evidence)}` }],
  });
  track(res);
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`${side} analyst returned no usable output`);
  return res.parsed_output;
}

const Summary = z.object({ summary: z.string() });

/** Neutral 2–3 sentence bottom line describing the core disagreement — never a verdict. */
export async function writeSummary(args: {
  company: string;
  ticker: string;
  bull: { title: string; explanation: string }[];
  bear: { title: string; explanation: string }[];
  language?: "en" | "he";
}): Promise<string> {
  const list = (xs: { title: string; explanation: string }[]) => xs.map((x, i) => `${i + 1}. ${x.title} — ${x.explanation}`).join("\n") || "(none)";
  const res = await claude().beta.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Summary) },
    system: `You write the neutral "bottom line" of a two-sided stock research report.
In 2–3 sentences, state what the bull and bear cases fundamentally disagree about. Use only the arguments given.
Never give a verdict, a recommendation, a price target, a probability or a score, and do not say which side is stronger. Neutral tone.
${languageRule(args.language)}`,
    messages: [{ role: "user", content: `${args.company} (${args.ticker})\n\nBull arguments:\n${list(args.bull)}\n\nBear arguments:\n${list(args.bear)}` }],
  });
  track(res);
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error("summary writer returned no usable output");
  return res.parsed_output.summary.trim();
}

/** Deterministic bottom line used without the Claude layer. */
export function fallbackSummary(bull: { title: string }[], bear: { title: string }[], language?: "en" | "he"): string {
  if (language === "he") {
    if (!bull.length && !bear.length) return "לא נמצאו מספיק טיעונים מבוססי מקורות לאף אחד מהצדדים.";
    return `נמצאו ${bull.length} טיעונים בעד ו-${bear.length} טיעונים נגד. ${bull[0] ? `הטיעון המרכזי בעד: ${bull[0].title}.` : ""} ${bear[0] ? `הטיעון המרכזי נגד: ${bear[0].title}.` : ""}`.trim();
  }
  if (!bull.length && !bear.length) return "Not enough source-backed arguments were found for either side.";
  return `${bull.length} bullish and ${bear.length} bearish arguments were found. ${bull[0] ? `The main bull point: ${bull[0].title}.` : ""} ${bear[0] ? `The main bear point: ${bear[0].title}.` : ""}`.trim();
}

/** Deterministic analysts used when the Claude layer is unavailable: one argument per directional SEC fact. */
export function rulesAnalyst(side: "bullish" | "bearish", evidence: ResearchEvidence[]): AnalystOutput {
  const want = side === "bullish" ? "BULLISH" : "BEARISH";
  const TITLES: Record<string, [string, string]> = {
    revenue: ["Revenue growth", "Revenue weakness"],
    qrevenue: ["Recent quarterly revenue momentum", "Slowing quarterly revenue"],
    opmargin: ["Expanding operating margin", "Contracting operating margin"],
    grossmargin: ["Improving gross margin", "Gross margin pressure"],
    opex: ["Operating leverage", "Costs rising faster than revenue"],
    netincome: ["Earnings growth", "Weak or declining earnings"],
    fcf: ["Strong free cash flow", "Negative free cash flow"],
    shares: ["Share count reduction", "Shareholder dilution"],
    balance: ["Net cash balance sheet", "Rising leverage"],
  };
  const args: DraftArgument[] = evidence
    .filter((e) => e.direction === want)
    .map((e) => {
      const key = e.event_key.replace(/^fin-/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
      const [bt, brt] = TITLES[key] ?? [e.claim.slice(0, 60), e.claim.slice(0, 60)];
      return {
        title: side === "bullish" ? bt : brt,
        explanation: `${e.claim} This is a reported figure from SEC filings; it describes fundamentals, not short-term price direction.`,
        evidence_summary: e.claim,
        evidence_ids: [e.id],
        counter_evidence_ids: [],
        materiality: e.materiality,
        time_horizon: e.horizon,
      };
    });
  return { arguments: args, conflicts: [], insufficient: args.length === 0 };
}
