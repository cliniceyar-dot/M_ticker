import type { BullBearAnalysis } from "./types";

/**
 * Analysis persistence. Uses a private Vercel Blob store when BLOB_READ_WRITE_TOKEN
 * is present (production), and an in-memory map otherwise (local dev, tests).
 * Path layout: research/{TICKER}/{analysis_id}.json — enables per-ticker history.
 */
export interface AnalysisStore {
  save(a: BullBearAnalysis): Promise<void>;
  get(id: string): Promise<BullBearAnalysis | null>;
  listByTicker(ticker: string, limit?: number): Promise<HistoryItem[]>;
}

export interface HistoryItem {
  analysis_id: string;
  ticker: string;
  created_at: string;
  status?: BullBearAnalysis["status"];
}

export function tickerFromId(id: string): string | null {
  const m = id.match(/^([A-Z0-9.\-]{1,12})_\d{8}T\d{6}Z_[a-z0-9]{6}$/);
  return m ? m[1] : null;
}

export function newAnalysisId(ticker: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${ticker.toUpperCase()}_${ts}_${rand}`;
}

const pathFor = (a: { ticker: string; analysis_id: string }) => `research/${a.ticker}/${a.analysis_id}.json`;

export class MemoryStore implements AnalysisStore {
  private m = new Map<string, BullBearAnalysis>();
  async save(a: BullBearAnalysis) {
    this.m.set(a.analysis_id, structuredClone(a));
  }
  async get(id: string) {
    const a = this.m.get(id);
    return a ? structuredClone(a) : null;
  }
  async listByTicker(ticker: string, limit = 20) {
    return [...this.m.values()]
      .filter((a) => a.ticker === ticker.toUpperCase())
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(({ analysis_id, ticker, created_at, status }) => ({ analysis_id, ticker, created_at, status }));
  }
}

export class BlobStore implements AnalysisStore {
  async save(a: BullBearAnalysis) {
    const { put } = await import("@vercel/blob");
    await put(pathFor(a), JSON.stringify(a), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
    });
  }
  async get(id: string) {
    const ticker = tickerFromId(id);
    if (!ticker) return null;
    const { get } = await import("@vercel/blob");
    const res = await get(pathFor({ ticker, analysis_id: id }), { access: "private", useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return (await new Response(res.stream).json()) as BullBearAnalysis;
  }
  async listByTicker(ticker: string, limit = 20) {
    const { list } = await import("@vercel/blob");
    const t = ticker.toUpperCase();
    const { blobs } = await list({ prefix: `research/${t}/`, limit: 1000 });
    return blobs
      .map((b) => b.pathname.split("/").pop()!.replace(/\.json$/, ""))
      .filter((id) => tickerFromId(id) === t)
      .sort()
      .reverse()
      .slice(0, limit)
      .map((id) => {
        const ts = id.split("_")[1];
        const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
        return { analysis_id: id, ticker: t, created_at: iso };
      });
  }
}

let singleton: AnalysisStore | null = null;
export function getStore(): AnalysisStore {
  if (!singleton) singleton = process.env.BLOB_READ_WRITE_TOKEN ? new BlobStore() : new MemoryStore();
  return singleton;
}
export function setStoreForTests(s: AnalysisStore | null) {
  singleton = s;
}
