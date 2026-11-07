import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { claude, GROUNDING_RULES, RESEARCH_MODEL } from "./claude";
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

export async function runAnalyst(side: "bullish" | "bearish", args: { company: string; ticker: string; asOf: Date; evidence: ResearchEvidence[] }): Promise<AnalystOutput> {
  const res = await claude().beta.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(Out) },
    system: `${ROLE[side]}
${GROUNDING_RULES}
Output rules:
- Up to 7 arguments, most material first. Each: a short descriptive title; a 2–4 sentence explanation of the argument and its financial significance; an evidence_summary with the key figures and dates; evidence_ids (required, from the input); counter_evidence_ids for credible evidence that challenges it.
- Several evidence records with the same "event" value are one underlying event, not independent confirmation.
- Prefer official filings and company documents for facts; use news and social items for context and narrative, labelled as such.
- Report material disagreements between sources in conflicts.
- Set insufficient=true when the evidence does not support any credible ${side} argument.`,
    messages: [{ role: "user", content: `Company: ${args.company} (${args.ticker}). Decision time: ${args.asOf.toISOString()}.\n\n${evidenceDigest(args.evidence)}` }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`${side} analyst returned no usable output`);
  return res.parsed_output;
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
