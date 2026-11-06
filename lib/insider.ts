import type { InsiderAnalysis, InsiderTransaction } from "./types";

const DAY = 86400_000;

function role(t: InsiderTransaction) {
  const title = t.title.toUpperCase();
  return {
    ceo: /\bCEO\b|CHIEF EXECUTIVE|PRESIDENT AND C\.?E\.?O/.test(title),
    cfo: /\bCFO\b|CHIEF FINANCIAL/.test(title),
    founderChair: /FOUNDER|EXECUTIVE CHAIR|CHAIRMAN AND/.test(title),
  };
}

/**
 * Insider Signal skill. Only open-market purchases (code P) count as conviction.
 * Awards (A), option exercises (M), tax withholding (F) and gifts (G) are ignored;
 * 10b5-1 plan trades are down-weighted. Weights follow the product spec (seed values).
 */
export function analyzeInsiders(transactions: InsiderTransaction[], asOf: Date, form4Count: number): InsiderAnalysis {
  const now = asOf.getTime();
  const purchases = transactions.filter((t) => t.code === "P" && t.acquired_disposed === "A" && !t.plan_10b5_1);
  const ageDays = (t: InsiderTransaction) => (now - Date.parse(t.trade_date + "T16:00:00Z")) / DAY;
  const recent30 = purchases.filter((t) => ageDays(t) <= 30);
  const older = purchases.filter((t) => ageDays(t) > 30 && ageDays(t) <= 90);
  const breakdown: { label: string; points: number }[] = [];

  if (recent30.some((t) => role(t).ceo)) breakdown.push({ label: "CEO open-market purchase in last 30 days", points: 12 });
  if (purchases.some((t) => role(t).cfo)) breakdown.push({ label: "CFO open-market purchase", points: 10 });
  if (purchases.some((t) => role(t).founderChair)) breakdown.push({ label: "Founder / Executive Chair purchase", points: 8 });
  const buyers = new Set(purchases.map((t) => t.owner));
  if (buyers.size >= 3) breakdown.push({ label: `Cluster of ${buyers.size} insiders buying`, points: 8 });
  if (purchases.some((t) => (t.value ?? 0) > 250_000)) breakdown.push({ label: "Single purchase > $250k", points: 5 });
  if (purchases.some((t) => (t.pct_change_ownership ?? 0) > 10)) breakdown.push({ label: "Purchase increased ownership > 10%", points: 4 });
  if (older.length && !recent30.length) breakdown.push({ label: "Purchase 31–90 days ago", points: 3 });

  // Routine selling: open-market sales (S) excluding 10b5-1, net of buys
  const sold = transactions
    .filter((t) => t.code === "S" && t.acquired_disposed === "D")
    .reduce((s, t) => s + (t.value ?? 0), 0);
  const bought = purchases.reduce((s, t) => s + (t.value ?? 0), 0);
  if (sold > bought && sold > 0 && purchases.length === 0) breakdown.push({ label: "Net routine selling", points: -2 });

  const directorOnlySmall =
    purchases.length > 0 && purchases.every((t) => t.is_director && !t.is_officer && (t.value ?? 0) < 50_000);
  if (directorOnlySmall && breakdown.length === 0) breakdown.push({ label: "Director-only small buy (low weight)", points: 1 });

  const score = breakdown.reduce((s, x) => s + x.points, 0);
  return {
    signal: score >= 8 ? "POSITIVE" : score < 0 ? "NEGATIVE" : "NEUTRAL",
    score,
    score_breakdown: breakdown,
    transactions: transactions.sort((a, b) => b.trade_date.localeCompare(a.trade_date)).slice(0, 40),
    form4_count: form4Count,
    available: true,
  };
}
