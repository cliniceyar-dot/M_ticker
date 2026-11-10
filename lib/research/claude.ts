import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";

export const RESEARCH_MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-opus-5-5";
export const PROMPT_VERSION = "bull-bear-prompts@1.1.0";

export function hasClaude() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
export function claude(): Anthropic {
  if (!client) client = new Anthropic({ timeout: 240_000, maxRetries: 1 });
  return client;
}

// ---- cost metering (per analysis run) ------------------------------------
// USD per million tokens; web search billed per request. Update when pricing changes.
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};
const WEB_SEARCH_USD = 0.01;

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export class CostMeter {
  usd = 0;
  calls = 0;
  add(model: string, usage: UsageLike | null | undefined) {
    if (!usage) return;
    const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
    this.calls++;
    this.usd +=
      ((usage.input_tokens ?? 0) * p.in + (usage.output_tokens ?? 0) * p.out + (usage.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6 +
      (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
  }
}

const meterStore = new AsyncLocalStorage<CostMeter>();
export function withCostMeter<T>(meter: CostMeter, fn: () => Promise<T>): Promise<T> {
  return meterStore.run(meter, fn);
}
/** Record a Messages API response's usage against the current run's meter (no-op outside a run). */
export function track(res: { model?: string; usage?: UsageLike | null }) {
  meterStore.getStore()?.add(res.model ?? RESEARCH_MODEL, res.usage);
}

/** Shared anti-hallucination rules injected into every research prompt. */
export const GROUNDING_RULES = `Hard rules:
- Use ONLY the evidence records supplied (or, for web research, pages you actually retrieved). Never invent sources, figures, article contents or publication times.
- Cite evidence by its id. An argument without valid evidence ids will be discarded.
- Distinguish confirmed facts, management statements, analyst interpretation, opinion and speculation.
- Social-media popularity is not evidence of investment value or price direction.
- A strong business outlook does not imply the stock will keep rising right after a breakout; keep fundamentals and short-term price direction separate.
- Never state a probability of price appreciation, a price target, or a buy/sell recommendation.
- If evidence is insufficient, say so instead of speculating.`;

export function languageRule(lang: "en" | "he" | undefined): string {
  return lang === "he"
    ? "Write every title, explanation, evidence summary and summary in Hebrew. Keep filing names, tickers and financial terms in English inside parentheses, e.g. \"הכנסות (Revenue)\", \"דוח רבעוני (10-Q)\"."
    : "Write in clear English.";
}
