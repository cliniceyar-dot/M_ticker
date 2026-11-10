import type { ProgressStatus } from "../research/pipeline";

/** Jobs, per-ticker version index and manual-refresh rate records (Vercel Blob in prod, memory locally). */

export type Lang = "en" | "he";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  job_id: string;
  ticker: string;
  language: Lang;
  status: JobStatus;
  trigger: "auto" | "manual" | "cron";
  progress: Record<string, ProgressStatus>;
  analysis_id: string;
  version: number | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionEntry {
  version: number;
  analysis_id: string;
  generated_at: string;
  cost_usd?: number;
}

export interface TickerIndex {
  ticker: string;
  language: Lang;
  versions: VersionEntry[];
  latest_job_id: string | null;
}

export interface StockStore {
  getJob(id: string): Promise<Job | null>;
  saveJob(job: Job): Promise<void>;
  getIndex(ticker: string, lang: Lang): Promise<TickerIndex | null>;
  saveIndex(idx: TickerIndex): Promise<void>;
  getRate(key: string): Promise<string | null>;
  setRate(key: string, iso: string): Promise<void>;
  listTracked(): Promise<{ ticker: string; language: Lang }[]>;
}

export class MemoryStockStore implements StockStore {
  jobs = new Map<string, Job>();
  idx = new Map<string, TickerIndex>();
  rate = new Map<string, string>();
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async saveJob(job: Job) {
    this.jobs.set(job.job_id, structuredClone(job));
  }
  async getIndex(ticker: string, lang: Lang) {
    const i = this.idx.get(`${ticker}/${lang}`);
    return i ? structuredClone(i) : null;
  }
  async saveIndex(i: TickerIndex) {
    this.idx.set(`${i.ticker}/${i.language}`, structuredClone(i));
  }
  async getRate(key: string) {
    return this.rate.get(key) ?? null;
  }
  async setRate(key: string, iso: string) {
    this.rate.set(key, iso);
  }
  async listTracked() {
    return [...this.idx.values()].map((i) => ({ ticker: i.ticker, language: i.language }));
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._\-]/g, "_");

export class BlobStockStore implements StockStore {
  private async read<T>(path: string): Promise<T | null> {
    const { get } = await import("@vercel/blob");
    const res = await get(path, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return (await new Response(res.stream).json()) as T;
  }
  private async write(path: string, data: unknown) {
    const { put } = await import("@vercel/blob");
    await put(path, JSON.stringify(data), { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json" });
  }
  getJob(id: string) {
    return this.read<Job>(`bb/jobs/${safe(id)}.json`);
  }
  saveJob(job: Job) {
    return this.write(`bb/jobs/${safe(job.job_id)}.json`, job);
  }
  getIndex(ticker: string, lang: Lang) {
    return this.read<TickerIndex>(`bb/index/${safe(ticker)}/${lang}.json`);
  }
  saveIndex(i: TickerIndex) {
    return this.write(`bb/index/${safe(i.ticker)}/${i.language}.json`, i);
  }
  async getRate(key: string) {
    return (await this.read<{ at: string }>(`bb/rate/${safe(key)}.json`))?.at ?? null;
  }
  setRate(key: string, iso: string) {
    return this.write(`bb/rate/${safe(key)}.json`, { at: iso });
  }
  async listTracked() {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: "bb/index/", limit: 1000 });
    return blobs
      .map((b) => b.pathname.match(/^bb\/index\/([^/]+)\/(en|he)\.json$/))
      .filter(Boolean)
      .map((m) => ({ ticker: m![1], language: m![2] as Lang }));
  }
}

let singleton: StockStore | null = null;
export function getStockStore(): StockStore {
  if (!singleton) singleton = process.env.BLOB_READ_WRITE_TOKEN ? new BlobStockStore() : new MemoryStockStore();
  return singleton;
}
export function setStockStoreForTests(s: StockStore | null) {
  singleton = s;
}

export function newJobId(ticker: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `job_${ticker.toUpperCase()}_${ts}_${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}
