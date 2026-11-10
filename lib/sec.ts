import { XMLParser } from "fast-xml-parser";
import { htmlToText, mapLimit, secJson, secText } from "./http";
import type { Entity, Evidence, InsiderTransaction } from "./types";
import { sectorFromSic } from "./sectors";

interface TickerTable {
  fields: string[];
  data: [number, string, string, string | null][];
}

let tickerCache: { at: number; map: Map<string, { cik: number; name: string; exchange: string | null }> } | null =
  null;

async function tickerMap() {
  if (tickerCache && Date.now() - tickerCache.at < 6 * 3600_000) return tickerCache.map;
  const table = await secJson<TickerTable>("https://www.sec.gov/files/company_tickers_exchange.json");
  const map = new Map<string, { cik: number; name: string; exchange: string | null }>();
  for (const [cik, name, ticker, exchange] of table.data) {
    const key = ticker.toUpperCase();
    if (!map.has(key)) map.set(key, { cik, name, exchange });
  }
  tickerCache = { at: Date.now(), map };
  return map;
}

export interface Submissions {
  cik: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  sic: string;
  sicDescription: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      acceptanceDateTime: string[];
      form: string[];
      items: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
    /** Older filing pages; present when history extends beyond `recent`. */
    files?: { name: string; filingFrom: string; filingTo: string }[];
  };
}

export interface Filing {
  accession: string;
  form: string;
  filingDate: string;
  acceptedAt: string; // ISO UTC
  items: string[];
  primaryDocument: string;
  description: string;
  url: string;
  indexUrl: string;
}

export function padCik(cik: number | string) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/**
 * EDGAR's acceptanceDateTime carries a trailing "Z" but the wall-clock value is
 * US Eastern time. Convert it to a real UTC instant.
 */
export function edgarEtToIso(raw: string): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return new Date(raw).toISOString();
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMin = nyOffsetMinutes(new Date(guess));
  return new Date(guess - offsetMin * 60_000).toISOString();
}

function nyOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(at);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const mm = tz.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!mm) return -300;
  const hours = Number(mm[1]);
  const mins = Number(mm[2] ?? 0) * Math.sign(hours || 1);
  return hours * 60 + mins;
}

export async function resolveEntity(tickerRaw: string): Promise<{ entity: Entity; submissions: Submissions }> {
  const ticker = tickerRaw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  if (!ticker) throw new Error("Empty ticker");
  const map = await tickerMap();
  const hit = map.get(ticker) ?? map.get(ticker.replace(".", "-")) ?? map.get(ticker.replace("-", "."));
  if (!hit) throw new Error(`Ticker ${ticker} not found in SEC EDGAR (US-listed SEC registrants only)`);
  const cik = padCik(hit.cik);
  const submissions = await secJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const sec = sectorFromSic(submissions.sic);
  return {
    submissions,
    entity: {
      ticker,
      company_name: submissions.name || hit.name,
      cik,
      exchange: hit.exchange ?? submissions.exchanges?.[0] ?? null,
      sic: submissions.sic || null,
      sector: sec.sector,
      industry: submissions.sicDescription || null,
      sector_etf: sec.etf,
    },
  };
}

export function listFilings(sub: Submissions, asOf: Date, lookbackDays: number): Filing[] {
  const r = sub.filings.recent;
  const cikNum = String(Number(sub.cik));
  const minTime = asOf.getTime() - lookbackDays * 86400_000;
  const out: Filing[] = [];
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const acceptedAt = r.acceptanceDateTime[i] ? edgarEtToIso(r.acceptanceDateTime[i]) : `${r.filingDate[i]}T21:00:00.000Z`;
    const t = Date.parse(acceptedAt);
    if (t > asOf.getTime()) continue; // point-in-time: never use anything published after as_of
    if (t < minTime) break; // recent[] is sorted newest-first
    const acc = r.accessionNumber[i];
    const accNoDash = acc.replace(/-/g, "");
    out.push({
      accession: acc,
      form: r.form[i],
      filingDate: r.filingDate[i],
      acceptedAt,
      items: (r.items[i] || "").split(",").map((s) => s.trim()).filter(Boolean),
      primaryDocument: r.primaryDocument[i],
      description: r.primaryDocDescription[i] || r.form[i],
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${r.primaryDocument[i]}`,
      indexUrl: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${acc}-index.htm`,
    });
  }
  return out;
}

export const EIGHT_K_ITEMS: Record<string, string> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.05": "Material Cybersecurity Incident",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.05": "Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting / Listing Rule Failure",
  "3.02": "Unregistered Sales of Equity Securities",
  "3.03": "Material Modification to Rights of Security Holders",
  "4.01": "Change in Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financials",
  "5.01": "Change in Control",
  "5.02": "Departure/Appointment of Directors or Officers",
  "5.03": "Amendments to Articles or Bylaws",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

const MATERIAL_FORMS = new Set([
  "8-K",
  "8-K/A",
  "6-K",
  "SC TO-T",
  "SC TO-C",
  "SC 14D9",
  "SC 13D",
  "425",
  "DEFM14A",
  "PREM14A",
  "10-Q",
  "10-K",
  "S-1",
  "S-3",
  "424B5",
]);

export function filingHeadline(f: Filing): string {
  if (f.form.startsWith("8-K") && f.items.length) {
    const named = f.items.filter((i) => i !== "9.01").map((i) => `Item ${i} ${EIGHT_K_ITEMS[i] ?? ""}`.trim());
    return `${f.form}: ${named.join("; ") || "Exhibits"}`;
  }
  return `${f.form}: ${f.description}`;
}

/** Build evidence objects from material filings, attaching text excerpts for the newest few. */
export async function buildFilingEvidence(filings: Filing[], maxExcerpts = 3): Promise<Evidence[]> {
  const material = filings.filter((f) => MATERIAL_FORMS.has(f.form)).slice(0, 12);
  const withText = material.filter((f) => /^(8-K|6-K|SC TO|SC 14D9|425)/.test(f.form)).slice(0, maxExcerpts);
  const excerpts = new Map<string, string>();
  await mapLimit(withText, 2, async (f) => {
    try {
      excerpts.set(f.accession, await fetchFilingExcerpt(f));
    } catch {
      /* excerpt is optional */
    }
  });
  return material.map((f, idx) => ({
    id: `sec-${idx + 1}`,
    source_type: "SEC_FILING" as const,
    source_name: `SEC EDGAR ${f.form}`,
    source_url: f.url,
    headline: filingHeadline(f),
    first_public_timestamp: f.acceptedAt,
    form: f.form,
    items: f.items,
    excerpt: excerpts.get(f.accession),
  }));
}

interface FilingIndex {
  directory: { item: { name: string; type?: string; size?: string | number }[] };
}

export async function fetchFilingExcerpt(f: Filing): Promise<string> {
  const base = f.url.slice(0, f.url.lastIndexOf("/") + 1);
  const parts: string[] = [];
  const primary = htmlToText(await secText(f.url));
  parts.push(primary.slice(0, 5000));
  // The press release is usually exhibit 99.1 — that's where the actual news lives.
  try {
    const idx = await secJson<FilingIndex>(`${base}index.json`);
    const ex = idx.directory.item.find((it) => /ex-?99|ex99|dex99/i.test(it.name) && /\.html?$/i.test(it.name));
    if (ex) {
      const exText = htmlToText(await secText(base + ex.name));
      parts.push(`\n--- EXHIBIT 99 (${ex.name}) ---\n${exText.slice(0, 9000)}`);
    }
  } catch {
    /* ignore */
  }
  return parts.join("\n").slice(0, 14000);
}

// ---------------- Form 4 ----------------

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: true, trimValues: true });

function arr<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
function val(x: unknown): unknown {
  if (x && typeof x === "object" && "value" in (x as Record<string, unknown>)) return (x as { value: unknown }).value;
  return x;
}
function num(x: unknown): number | null {
  const v = val(x);
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function bool(x: unknown): boolean {
  const v = String(val(x) ?? "").toLowerCase();
  return v === "1" || v === "true";
}

export async function fetchForm4Transactions(filings: Filing[], max = 15): Promise<{
  transactions: InsiderTransaction[];
  count: number;
  errors: string[];
}> {
  const f4 = filings.filter((f) => f.form === "4" || f.form === "4/A").slice(0, max);
  const errors: string[] = [];
  const results = await mapLimit(f4, 3, async (f) => {
    try {
      // primaryDocument is often "xslF345X05/form4.xml" (the rendered view); the raw XML lives
      // one level up, directly in the accession folder.
      const rawDoc = f.primaryDocument.replace(/^xsl[^/]+\//i, "");
      const url = f.url.slice(0, f.url.length - f.primaryDocument.length) + rawDoc;
      return parseForm4Xml(await secText(url), f);
    } catch (e) {
      errors.push((e as Error).message);
      return [] as InsiderTransaction[];
    }
  });
  return { transactions: results.flat(), count: f4.length, errors };
}

/** Parse a raw Form 4 XML document into normalized non-derivative transactions. */
export function parseForm4Xml(xmlText: string, f: Filing): InsiderTransaction[] {
  return parseForm4(xml.parse(xmlText) as Record<string, unknown>, f, f.url);
}

function parseForm4(doc: Record<string, unknown>, f: Filing, humanUrl: string): InsiderTransaction[] {
  if (!doc.ownershipDocument) throw new Error("no ownershipDocument in Form 4 XML");
  const od = doc.ownershipDocument as Record<string, unknown>;
  const owners = arr(od.reportingOwner as Record<string, unknown> | Record<string, unknown>[]);
  const o = owners[0] ?? {};
  const id = (o.reportingOwnerId ?? {}) as Record<string, unknown>;
  const rel = (o.reportingOwnerRelationship ?? {}) as Record<string, unknown>;
  const ownerName = owners.map((x) => String(((x.reportingOwnerId ?? {}) as Record<string, unknown>).rptOwnerName ?? "")).join(" / ") ||
    String(id.rptOwnerName ?? "Unknown");
  const titleBits: string[] = [];
  if (rel.officerTitle) titleBits.push(String(rel.officerTitle));
  if (bool(rel.isDirector)) titleBits.push("Director");
  if (bool(rel.isTenPercentOwner)) titleBits.push("10% Owner");
  if (rel.otherText) titleBits.push(String(rel.otherText));
  const plan = bool(od.aff10b5One);
  const nd = (od.nonDerivativeTable ?? {}) as Record<string, unknown>;
  const txs = arr(nd.nonDerivativeTransaction as Record<string, unknown> | Record<string, unknown>[]);
  return txs.map((t) => {
    const coding = (t.transactionCoding ?? {}) as Record<string, unknown>;
    const amounts = (t.transactionAmounts ?? {}) as Record<string, unknown>;
    const post = (t.postTransactionAmounts ?? {}) as Record<string, unknown>;
    const shares = num(amounts.transactionShares) ?? 0;
    const price = num(amounts.transactionPricePerShare);
    const ad = String(val(amounts.transactionAcquiredDisposedCode) ?? "?") as "A" | "D" | "?";
    const after = num(post.sharesOwnedFollowingTransaction);
    let pct: number | null = null;
    if (after !== null && shares > 0) {
      const before = ad === "A" ? after - shares : after + shares;
      pct = before > 0 ? ((after - before) / before) * 100 : null;
    }
    return {
      filed_at: f.acceptedAt,
      trade_date: String(val(t.transactionDate) ?? f.filingDate).slice(0, 10),
      owner: ownerName,
      title: titleBits.join(", ") || "Insider",
      is_director: bool(rel.isDirector),
      is_officer: bool(rel.isOfficer),
      is_ten_pct: bool(rel.isTenPercentOwner),
      code: String(coding.transactionCode ?? "?"),
      acquired_disposed: ad,
      shares,
      price,
      value: price !== null ? shares * price : null,
      owned_after: after,
      pct_change_ownership: pct,
      plan_10b5_1: plan,
      source_url: humanUrl,
    };
  });
}
