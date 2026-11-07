import Anthropic from "@anthropic-ai/sdk";

export const RESEARCH_MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-opus-5-5";
export const PROMPT_VERSION = "bull-bear-prompts@1.0.0";

export function hasClaude() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
export function claude(): Anthropic {
  if (!client) client = new Anthropic({ timeout: 240_000, maxRetries: 1 });
  return client;
}

/** Shared anti-hallucination rules injected into every research prompt. */
export const GROUNDING_RULES = `Hard rules:
- Use ONLY the evidence records supplied (or, for web research, pages you actually retrieved). Never invent sources, figures, article contents or publication times.
- Cite evidence by its id. An argument without valid evidence ids will be discarded.
- Distinguish confirmed facts, management statements, analyst interpretation, opinion and speculation.
- Social-media popularity is not evidence of investment value or price direction.
- A strong business outlook does not imply the stock will keep rising right after a breakout; keep fundamentals and short-term price direction separate.
- Never state a probability of price appreciation.
- If evidence is insufficient, say so instead of speculating.`;
