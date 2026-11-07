import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { fetchFilingExcerpt, type Filing } from "../sec";
import { mapLimit } from "../http";
import { claude, GROUNDING_RULES, RESEARCH_MODEL } from "./claude";
import type { ResearchEvidence, ResearchSource } from "./types";

/**
 * Skill 1 — Company Strategy Research.
 * Official statements over the history window = earnings / Reg FD press releases
 * furnished with 8-Ks (Exhibit 99). Claude extracts management commitments and
 * compares them with later reported outcomes (later releases + XBRL evidence).
 */

const STRATEGY_ITEMS = ["2.02", "7.01", "8.01", "1.01", "2.01"];

/** Pick a spread of official releases: the most recent ones plus one per year back. */
export function selectReleases(filings: Filing[], max = 7): Filing[] {
  const eightKs = filings.filter((f) => f.form.startsWith("8-K") && f.items.some((i) => STRATEGY_ITEMS.includes(i)));
  const earnings = eightKs.filter((f) => f.items.includes("2.02"));
  const pool = earnings.length >= 3 ? earnings : eightKs;
  if (pool.length <= max) return pool;
  const picked = new Set<Filing>(pool.slice(0, 3)); // newest-first
  const newest = Date.parse(pool[0].acceptedAt);
  for (const yearsBack of [1, 2, 3]) {
    const target = newest - yearsBack * 365 * 86400_000;
    const nearest = pool.reduce((a, b) => (Math.abs(Date.parse(b.acceptedAt) - target) < Math.abs(Date.parse(a.acceptedAt) - target) ? b : a));
    picked.add(nearest);
  }
  for (const f of pool) {
    if (picked.size >= max) break;
    picked.add(f);
  }
  return [...picked].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt)).slice(0, max);
}

/** Keep the forward-looking parts of a release (outlook, guidance, targets, plans). */
export function focusOnOutlook(text: string, max = 5000): string {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40);
  const key = /\b(outlook|guidance|expect|anticipat|target|plan|forecast|strateg|priorit|long-term|roadmap|launch|expan|invest|acqui|partner|record|margin|revenue)/i;
  const lead = paras.slice(0, 6);
  const focused = paras.filter((p) => key.test(p));
  const out: string[] = [];
  let len = 0;
  for (const p of [...lead, ...focused]) {
    if (out.includes(p)) continue;
    if (len + p.length > max) break;
    out.push(p);
    len += p.length;
  }
  return out.join("\n");
}

export interface StrategyResult {
  evidence: ResearchEvidence[];
  sources: ResearchSource[];
  status: "ok" | "partial" | "unavailable" | "error";
  note?: string;
}

export function releaseSources(releases: Filing[], company: string, retrievedAt: string): ResearchSource[] {
  return releases.map((f) => ({
    id: `rel-${f.accession}`,
    url: f.url,
    title: `${f.form} (${f.items.join(", ")}) — ${company} official release ${f.filingDate}`,
    provider: "SEC EDGAR (company release)",
    kind: "company_release" as const,
    channel: "strategy" as const,
    published_at: f.acceptedAt,
    retrieved_at: retrievedAt,
    form: f.form,
  }));
}

const Commitments = z.object({
  findings: z.array(
    z.object({
      claim: z.string(),
      kind: z.enum(["commitment_met", "commitment_missed", "commitment_exceeded", "commitment_pending", "position_changed", "new_initiative", "emerging_risk", "guidance"]),
      direction: z.enum(["BULLISH", "BEARISH", "MIXED", "NEUTRAL"]),
      materiality: z.enum(["high", "medium", "low"]),
      horizon: z.enum(["short_term", "medium_term", "long_term"]),
      verification: z.enum(["confirmed_fact", "management_statement"]),
      source_ids: z.array(z.string()),
      outcome_evidence_ids: z.array(z.string()),
      event_key: z.string(),
    }),
  ),
});

export async function researchStrategy(args: {
  releases: Filing[];
  company: string;
  ticker: string;
  asOf: Date;
  financialEvidence: ResearchEvidence[];
  retrievedAt: string;
  useClaude: boolean;
}): Promise<StrategyResult> {
  const { releases, company, ticker, asOf, financialEvidence, retrievedAt, useClaude } = args;
  if (!releases.length) return { evidence: [], sources: [], status: "unavailable", note: "No official 8-K releases found in the window." };
  const sources = releaseSources(releases, company, retrievedAt);
  if (!useClaude) {
    return { evidence: [], sources, status: "partial", note: "Official releases located; extracting management commitments requires the Claude research layer (ANTHROPIC_API_KEY)." };
  }

  const texts = await mapLimit(releases, 2, async (f) => {
    try {
      return focusOnOutlook(await fetchFilingExcerpt(f));
    } catch {
      return "";
    }
  });
  const docs = releases
    .map((f, i) => (texts[i] ? `<release id="rel-${f.accession}" published="${f.acceptedAt}" form="${f.form}" items="${f.items.join(",")}">\n${texts[i]}\n</release>` : ""))
    .filter(Boolean)
    .join("\n\n");
  if (!docs) return { evidence: [], sources, status: "error", note: "Release text could not be retrieved from EDGAR." };
  const fin = financialEvidence.map((e) => `<reported id="${e.id}" date="${e.published_at}">${e.claim}</reported>`).join("\n");

  const res = await claude().beta.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(Commitments) },
    system: `You are the Company Strategy Research agent for an equity research tool. From official company releases (oldest to newest) extract management's strategic commitments, guidance and initiatives, then check each against LATER releases and reported financial results.
${GROUNDING_RULES}
- source_ids must be release ids from the input; outcome_evidence_ids must be later release ids or reported ids (or empty when pending/unverifiable).
- A management statement is verification "management_statement"; only reported results are "confirmed_fact".
- Call out missed commitments, changes in management's position, unexpected improvements and emerging risks.
- event_key: a short stable slug for the underlying topic (e.g. "fy26-revenue-guidance").
- Return at most 12 findings, most material first.`,
    messages: [
      {
        role: "user",
        content: `Company: ${company} (${ticker}). Decision time (as_of): ${asOf.toISOString()}.\n\n${docs}\n\nReported financial results (SEC XBRL):\n${fin || "(none)"}`,
      },
    ],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return { evidence: [], sources, status: "error", note: "Strategy agent returned no usable output." };

  const valid = new Set([...sources.map((s) => s.id), ...financialEvidence.map((e) => e.id)]);
  const srcIds = new Set(sources.map((s) => s.id));
  const evidence: ResearchEvidence[] = [];
  for (const f of res.parsed_output.findings) {
    const ids = f.source_ids.filter((id) => srcIds.has(id));
    if (!ids.length) continue; // anti-hallucination: must cite a real release
    const outcomeSrc = f.outcome_evidence_ids
      .filter((id) => valid.has(id))
      .flatMap((id) => (srcIds.has(id) ? [id] : financialEvidence.find((e) => e.id === id)?.source_ids ?? []));
    const allIds = [...new Set([...ids, ...outcomeSrc])];
    const dates = allIds.map((id) => sources.find((s) => s.id === id)?.published_at).filter(Boolean) as string[];
    evidence.push({
      id: `str-${evidence.length + 1}`,
      source_ids: allIds,
      claim: f.claim,
      direction: f.direction,
      materiality: f.materiality,
      verification: f.verification,
      horizon: f.horizon,
      event_key: `str-${f.event_key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      published_at: dates.sort().at(-1) ?? null,
      channel: "strategy",
      metrics: { kind: f.kind },
    });
  }
  return { evidence, sources, status: "ok", note: "Earnings-call transcripts are not available from free official sources; strategy research uses 8-K releases." };
}
