import type { CatalystCategory } from "./types";

/** Seed base-strength ranges (0–25) per catalyst. Replace with backtest-estimated coefficients. */
export const BASE_STRENGTH: Record<CatalystCategory, [number, number]> = {
  "M&A_OFFER": [24, 25],
  FDA_APPROVAL: [22, 25],
  FDA_TRIAL_RESULT: [20, 25],
  EARNINGS_GUIDANCE_RAISE: [20, 24],
  EARNINGS_POSITIVE_SURPRISE: [15, 20],
  MAJOR_CONTRACT: [19, 23],
  PARTNERSHIP: [17, 22],
  INDEX_INCLUSION: [15, 20],
  LEGAL_REGULATORY_WIN: [14, 20],
  ANALYST_UPGRADE: [10, 16],
  CAPITAL_RETURN: [8, 14],
  BUYBACK: [8, 14],
  "M&A_COMPLETION": [5, 10],
  EARNINGS_MIXED: [6, 12],
  DEBT_REFINANCING: [5, 10],
  MANAGEMENT_CHANGE: [4, 10],
  INSIDER_BUYING: [6, 12],
  PRICE_TARGET_RAISE: [5, 10],
  SECTOR_SYMPATHY: [5, 12],
  MACRO_SYMPATHY: [3, 8],
  SHORT_SQUEEZE_LIKELY: [4, 10],
  KNOWN_EVENT_MATERIALIZATION: [5, 12],
  TECHNICAL_ONLY: [0, 8],
  RUMOR_UNCONFIRMED: [3, 8],
  NO_IDENTIFIABLE_NEWS: [0, 8],
  CONFLICTING_INFORMATION: [0, 5],
};

export const CATEGORY_LABEL: Record<CatalystCategory, string> = {
  EARNINGS_POSITIVE_SURPRISE: "Earnings beat",
  EARNINGS_GUIDANCE_RAISE: "Earnings beat + guidance raise",
  EARNINGS_MIXED: "Mixed earnings",
  FDA_APPROVAL: "FDA approval",
  FDA_TRIAL_RESULT: "Clinical trial result",
  "M&A_OFFER": "M&A offer",
  "M&A_COMPLETION": "M&A completion",
  MAJOR_CONTRACT: "Major contract",
  PARTNERSHIP: "Strategic partnership",
  ANALYST_UPGRADE: "Analyst upgrade",
  PRICE_TARGET_RAISE: "Price target raise",
  INDEX_INCLUSION: "Index inclusion",
  CAPITAL_RETURN: "Capital return",
  BUYBACK: "Buyback",
  DEBT_REFINANCING: "Debt refinancing",
  LEGAL_REGULATORY_WIN: "Legal / regulatory win",
  MANAGEMENT_CHANGE: "Management change",
  INSIDER_BUYING: "Insider buying",
  SECTOR_SYMPATHY: "Sector sympathy",
  MACRO_SYMPATHY: "Macro sympathy",
  SHORT_SQUEEZE_LIKELY: "Short squeeze likely",
  TECHNICAL_ONLY: "Technical only",
  RUMOR_UNCONFIRMED: "Unconfirmed rumor",
  KNOWN_EVENT_MATERIALIZATION: "Known event materialization",
  NO_IDENTIFIABLE_NEWS: "No identifiable news",
  CONFLICTING_INFORMATION: "Conflicting information",
};

export function midStrength(c: CatalystCategory) {
  const [a, b] = BASE_STRENGTH[c];
  return (a + b) / 2;
}
