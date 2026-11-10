import type Anthropic from "@anthropic-ai/sdk";
import { claude, GROUNDING_RULES, RESEARCH_MODEL, track } from "./claude";
import type { Channel, ChannelCoverage, Direction, ResearchEvidence, ResearchSource, SourceKind, Verification } from "./types";

/**
 * Skill 3 — News & Social Media Research.
 * Uses Claude's server-side web search restricted per channel to the providers
 * named in the spec. Only pages the search tool actually returned can become
 * sources; findings without such a citation are dropped. Providers whose content
 * is not reachable through search are reported as unavailable, not omitted.
 */

export const CHANNEL_DOMAINS: Record<"news" | "youtube" | "x" | "instagram", string[]> = {
  news: ["bloomberg.com", "finance.yahoo.com", "reuters.com", "cnbc.com", "wsj.com", "marketwatch.com", "ft.com", "barrons.com", "investors.com", "apnews.com", "fool.com", "seekingalpha.com"],
  youtube: ["youtube.com"],
  x: ["x.com", "twitter.com"],
  instagram: ["instagram.com"],
};

const KIND: Record<string, SourceKind> = { news: "news", youtube: "video", x: "social", instagram: "social" };

/** Parse search-result page ages: absolute dates or relative ("3 days ago"). */
export function parsePageAge(age: string | null | undefined, now: Date): string | null {
  if (!age) return null;
  const s = age.trim().toLowerCase();
  const rel = s.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago$/);
  if (rel) {
    const n = Number(rel[1]);
    const ms = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30.44 * 86400e3, year: 365 * 86400e3 }[rel[2] as "day"];
    return new Date(now.getTime() - n * ms).toISOString();
  }
  if (s === "yesterday") return new Date(now.getTime() - 86400e3).toISOString();
  const t = Date.parse(age);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export type InWindow = "in" | "too_old" | "after_as_of" | "undated";
export function windowCheck(publishedAt: string | null, asOf: Date, months: number): InWindow {
  if (!publishedAt) return "undated";
  const t = Date.parse(publishedAt);
  if (t > asOf.getTime() + 60_000) return "after_as_of";
  if (t < asOf.getTime() - months * 30.44 * 86400e3) return "too_old";
  return "in";
}

const TAG = /^\s*\[\s*(BULLISH|BEARISH|MIXED|NEUTRAL)\s*;\s*(FACT|MGMT|ANALYST|OPINION|SPECULATION)\s*;\s*([a-z0-9][a-z0-9\-]{1,60})\s*\]\s*/i;
const VER: Record<string, Verification> = { FACT: "confirmed_fact", MGMT: "management_statement", ANALYST: "analyst_interpretation", OPINION: "opinion", SPECULATION: "speculation" };

export interface ParsedFinding {
  direction: Direction;
  verification: Verification;
  event_key: string;
  claim: string;
  urls: string[];
}

/** Turn a web-search response into findings, keeping only citations to retrieved pages. */
export function parseSearchResponse(content: Anthropic.Beta.BetaContentBlock[]): {
  findings: ParsedFinding[];
  results: Map<string, { title: string; page_age: string | null }>;
  searchErrors: string[];
} {
  const results = new Map<string, { title: string; page_age: string | null }>();
  const searchErrors: string[] = [];
  let text = "";
  const spans: { start: number; end: number; urls: string[] }[] = [];
  for (const b of content) {
    if (b.type === "web_search_tool_result") {
      if (Array.isArray(b.content)) for (const r of b.content) results.set(r.url, { title: r.title, page_age: r.page_age ?? null });
      else searchErrors.push((b.content as { error_code?: string }).error_code ?? "search_error");
    } else if (b.type === "text") {
      const start = text.length;
      text += b.text;
      const urls = (b.citations ?? []).flatMap((c) => (c.type === "web_search_result_location" ? [c.url] : []));
      spans.push({ start, end: text.length, urls });
    }
  }
  const findings: ParsedFinding[] = [];
  let pos = 0;
  for (const chunk of text.split("§")) {
    const start = pos;
    const end = pos + chunk.length;
    pos = end + 1;
    const m = chunk.match(TAG);
    if (!m) continue;
    const urls = [...new Set(spans.filter((s) => s.end > start && s.start < end).flatMap((s) => s.urls))].filter((u) => results.has(u));
    const claim = chunk.replace(TAG, "").replace(/\s+/g, " ").trim();
    if (!claim || !urls.length) continue;
    findings.push({ direction: m[1].toUpperCase() as Direction, verification: VER[m[2].toUpperCase()], event_key: m[3].toLowerCase(), claim, urls });
  }
  return { findings, results, searchErrors };
}

function prompt(channel: keyof typeof CHANNEL_DOMAINS, company: string, ticker: string, aliases: string[], from: string, to: string) {
  const focus = {
    news: "financial journalism and company news: material events, earnings coverage, analyst actions, sector developments",
    youtube: "equity-research and earnings-analysis videos, management interviews, market commentary",
    x: "analyst opinions, developing stories and investor discussion on X/Twitter",
    instagram: "public financial commentary and corporate announcements on Instagram",
  }[channel];
  return `Research ${company} (ticker ${ticker}${aliases.length ? `; also known as ${aliases.join(", ")}` : ""}) — ${focus}.
Only consider items published between ${from} and ${to}. Search by ticker, company name and, where useful, key executives or products.

Report up to 10 distinct findings. Write EACH finding on its own line starting with "§" and a tag:
§ [DIRECTION; VERIFICATION; event-key] One or two sentences stating the finding, citing the page.
- DIRECTION: BULLISH, BEARISH, MIXED or NEUTRAL for the company's prospects.
- VERIFICATION: FACT (independently reported fact), MGMT (company/management statement), ANALYST (analyst interpretation), OPINION, or SPECULATION (rumor/unverified).
- event-key: a short lowercase slug for the underlying event; reuse the SAME key when several outlets cover the same event (reposts are not independent evidence).
Prefer original reporting over reposts. Flag contradictions and unverified rumors as such. If you find nothing relevant in the window, write "§ none".
${GROUNDING_RULES}`;
}

export interface ChannelResult {
  evidence: ResearchEvidence[];
  sources: ResearchSource[];
  coverage: ChannelCoverage;
}

export async function researchChannel(args: {
  channel: keyof typeof CHANNEL_DOMAINS;
  company: string;
  ticker: string;
  aliases: string[];
  asOf: Date;
  months: number;
  /** Lookback in days; overrides `months` when set. */
  days?: number;
  historical: boolean;
  retrievedAt: string;
}): Promise<ChannelResult> {
  const { channel, company, ticker, aliases, asOf, historical, retrievedAt } = args;
  const months = args.days ? args.days / 30.44 : args.months;
  const from = new Date(asOf.getTime() - months * 30.44 * 86400e3).toISOString().slice(0, 10);
  const to = asOf.toISOString().slice(0, 10);
  const coverage: ChannelCoverage = { channel, requested: true, status: "ok", window: { from, to }, items: 0 };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt(channel, company, ticker, aliases, from, to) }];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const res = await claude().beta.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6, allowed_domains: CHANNEL_DOMAINS[channel] }],
      messages,
    });
    track(res);
    if (res.stop_reason === "refusal") {
      return { evidence: [], sources: [], coverage: { ...coverage, status: "error", note: "Research request declined." } };
    }
    content.push(...res.content);
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
  }

  const { findings, results, searchErrors } = parseSearchResponse(content);
  const sources = new Map<string, ResearchSource>();
  const evidence: ResearchEvidence[] = [];
  let dropped = { old: 0, future: 0, undated: 0 };
  for (const f of findings) {
    const srcIds: string[] = [];
    let latest: string | null = null;
    for (const url of f.urls) {
      const r = results.get(url)!;
      const published = parsePageAge(r.page_age, new Date(retrievedAt));
      const w = windowCheck(published, asOf, months);
      if (w === "too_old") { dropped.old++; continue; }
      if (w === "after_as_of") { dropped.future++; continue; }
      if (w === "undated" && historical) { dropped.undated++; continue; } // point-in-time: can't prove it existed
      const id = `${channel}-${hash(url)}`;
      if (!sources.has(id)) {
        let host = url;
        try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep url */ }
        sources.set(id, { id, url, title: r.title, provider: host, kind: KIND[channel], channel, published_at: published, retrieved_at: retrievedAt });
      }
      srcIds.push(id);
      if (published && (!latest || published > latest)) latest = published;
    }
    if (!srcIds.length) continue;
    evidence.push({
      id: `${channel}-ev-${evidence.length + 1}`,
      source_ids: srcIds,
      claim: f.claim,
      direction: f.direction,
      verification: f.verification,
      materiality: f.verification === "confirmed_fact" || f.verification === "management_statement" ? "medium" : "low",
      horizon: "short_term",
      event_key: `news-${f.event_key}`,
      published_at: latest,
      channel: channel as Channel,
    });
  }

  coverage.items = evidence.length;
  coverage.scanned = results.size;
  const notes: string[] = [];
  if (searchErrors.length) notes.push(`search errors: ${[...new Set(searchErrors)].join(", ")}`);
  if (dropped.old + dropped.future + dropped.undated) notes.push(`excluded ${dropped.old} outside window, ${dropped.future} published after as_of, ${dropped.undated} undated`);
  if (!results.size) {
    coverage.status = searchErrors.length ? "error" : "unavailable";
    notes.push(`no pages from ${CHANNEL_DOMAINS[channel].join(", ")} were reachable through search`);
  } else if (!evidence.length) {
    coverage.status = "partial";
    notes.push("pages retrieved but no relevant, citable findings in the window");
  }
  coverage.note = notes.join("; ") || undefined;
  return { evidence, sources: [...sources.values()], coverage };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
