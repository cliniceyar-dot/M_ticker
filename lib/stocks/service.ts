import { edgarEtToIso, resolveEntity, type Submissions } from "../sec";
import { getStore, newAnalysisId } from "../research/store";
import { newAnalysis, runBullBear } from "../research/pipeline";
import { DEFAULT_OPTIONS, type BullBearAnalysis } from "../research/types";
import { BB_CONFIG } from "./config";
import { toSpecResponse, type Filters, type SpecResponse } from "./spec";
import { getStockStore, newJobId, type Job, type Lang, type TickerIndex } from "./store";

/**
 * Bull/Bear analysis service — cache, freshness, jobs, versions and rate limits
 * (feature spec sections 2, 6 and 7).
 */

export type Schedule = (task: () => Promise<unknown>) => void;

export const CHANNELS = ["sec", "strategy", "news", "youtube", "x", "instagram", "analysis"] as const;
const REFRESH_FORMS = /^(8-K|10-Q|10-K)/;

export class NotFoundError extends Error {}

export function jobOptions(lang: Lang) {
  return {
    ...DEFAULT_OPTIONS,
    company_history_months: BB_CONFIG.officialLookbackMonths,
    recent_media_months: Math.ceil(BB_CONFIG.newsLookbackDays / 30),
    news_days: BB_CONFIG.newsLookbackDays,
    social_days: BB_CONFIG.socialLookbackDays,
    language: lang,
  };
}

/** True when a 10-K/10-Q/8-K was accepted after `since` (an immediate-refresh trigger). */
export function hasNewFiling(sub: Submissions, since: string): boolean {
  const r = sub.filings.recent;
  for (let i = 0; i < r.form.length; i++) {
    const accepted = Date.parse(r.acceptanceDateTime[i] ? edgarEtToIso(r.acceptanceDateTime[i]) : `${r.filingDate[i]}T21:00:00Z`);
    if (accepted <= Date.parse(since)) break; // recent[] is newest-first
    if (REFRESH_FORMS.test(r.form[i]) && accepted > Date.parse(since)) return true;
  }
  return false;
}

export function isFresh(entry: { generated_at: string } | undefined, sub: Submissions | null, now: Date): boolean {
  if (!entry) return false;
  if (now.getTime() - Date.parse(entry.generated_at) > BB_CONFIG.freshHours * 3600e3) return false;
  return !(sub && hasNewFiling(sub, entry.generated_at));
}

function jobActive(job: Job | null, now: Date) {
  return !!job && (job.status === "queued" || job.status === "running") && now.getTime() - Date.parse(job.updated_at) < BB_CONFIG.jobStaleMinutes * 60e3;
}

async function resolveOr404(ticker: string): Promise<Submissions> {
  try {
    return (await resolveEntity(ticker)).submissions;
  } catch (e) {
    if (/not found|Empty ticker/i.test((e as Error).message)) throw new NotFoundError(`Unknown or delisted ticker: ${ticker}`);
    throw e;
  }
}

export async function startJob(ticker: string, lang: Lang, trigger: Job["trigger"], schedule: Schedule, now = new Date()): Promise<Job> {
  const store = getStockStore();
  const analysis = newAnalysis(newAnalysisId(ticker, now), ticker, now, jobOptions(lang));
  await getStore().save(analysis);
  const job: Job = {
    job_id: newJobId(ticker, now),
    ticker,
    language: lang,
    status: "queued",
    trigger,
    progress: Object.fromEntries(CHANNELS.map((c) => [c, "pending"])),
    analysis_id: analysis.analysis_id,
    version: null,
    attempts: 0,
    error: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await store.saveJob(job);
  const idx: TickerIndex = (await store.getIndex(ticker, lang)) ?? { ticker, language: lang, versions: [], latest_job_id: null };
  idx.latest_job_id = job.job_id;
  await store.saveIndex(idx);
  schedule(() => runJob(job, analysis));
  return job;
}

/** Run (and retry once) a generation job; on success append a new version. Idempotent per job. */
export async function runJob(job: Job, analysis: BullBearAnalysis, maxAttempts = 2): Promise<Job> {
  const store = getStockStore();
  const save = async () => {
    job.updated_at = new Date().toISOString();
    await store.saveJob(job);
  };
  job.status = "running";
  await save();
  let result: BullBearAnalysis | null = null;
  while (job.attempts < maxAttempts) {
    job.attempts++;
    result = await runBullBear(analysis, {
      onProgress: async (ch, st) => {
        job.progress[ch] = st;
        await save();
      },
    });
    if (result.status === "completed") break;
    job.error = result.error ?? "analysis failed";
  }
  if (!result || result.status !== "completed") {
    job.status = "failed";
    await save();
    return job;
  }
  const idx: TickerIndex = (await store.getIndex(job.ticker, job.language)) ?? { ticker: job.ticker, language: job.language, versions: [], latest_job_id: job.job_id };
  const version = (idx.versions.at(-1)?.version ?? 0) + 1;
  idx.versions.push({ version, analysis_id: result.analysis_id, generated_at: result.completed_at ?? new Date().toISOString(), cost_usd: result.cost_usd });
  await store.saveIndex(idx);
  job.status = "done";
  job.version = version;
  job.error = null;
  await save();
  return job;
}

export type GetResult =
  | { kind: "ready"; body: SpecResponse }
  | { kind: "pending"; job: Job; previous: { version: number; generated_at: string } | null };

export async function getBullBear(ticker: string, lang: Lang, filters: Filters, schedule: Schedule, opts: { version?: number; now?: Date } = {}): Promise<GetResult> {
  const now = opts.now ?? new Date();
  const store = getStockStore();
  const idx = await store.getIndex(ticker, lang);

  if (opts.version) {
    const v = idx?.versions.find((x) => x.version === opts.version);
    const a = v && (await getStore().get(v.analysis_id));
    if (!v || !a) throw new NotFoundError(`Version ${opts.version} not found for ${ticker}`);
    return { kind: "ready", body: toSpecResponse(a, v.version, filters, { now }) };
  }

  const sub = await resolveOr404(ticker);
  const latest = idx?.versions.at(-1);
  if (latest && isFresh(latest, sub, now)) {
    const a = await getStore().get(latest.analysis_id);
    if (a) return { kind: "ready", body: toSpecResponse(a, latest.version, filters, { now }) };
  }

  const lastJob = idx?.latest_job_id ? await store.getJob(idx.latest_job_id) : null;
  const previous = latest ? { version: latest.version, generated_at: latest.generated_at } : null;
  if (jobActive(lastJob, now)) return { kind: "pending", job: lastJob!, previous };

  // The last attempt failed recently: serve the last good version marked stale instead of hammering sources.
  if (latest && lastJob?.status === "failed" && now.getTime() - Date.parse(lastJob.updated_at) < BB_CONFIG.manualRefreshMinutes * 60e3) {
    const a = await getStore().get(latest.analysis_id);
    if (a) return { kind: "ready", body: toSpecResponse(a, latest.version, filters, { stale: true, now }) };
  }

  const job = await startJob(ticker, lang, "auto", schedule, now);
  return { kind: "pending", job, previous };
}

export type RefreshResult = { kind: "started"; job: Job } | { kind: "rate_limited"; retryAfterSec: number };

/** Manual refresh: at most once per configured window per user (and ticker). */
export async function manualRefresh(ticker: string, lang: Lang, clientKey: string, schedule: Schedule, now = new Date()): Promise<RefreshResult> {
  const store = getStockStore();
  await resolveOr404(ticker);
  const key = `${ticker}_${clientKey}`;
  const last = await store.getRate(key);
  const windowMs = BB_CONFIG.manualRefreshMinutes * 60e3;
  if (last && now.getTime() - Date.parse(last) < windowMs) {
    return { kind: "rate_limited", retryAfterSec: Math.ceil((Date.parse(last) + windowMs - now.getTime()) / 1000) };
  }
  await store.setRate(key, now.toISOString());
  const idx = await store.getIndex(ticker, lang);
  const running = idx?.latest_job_id ? await store.getJob(idx.latest_job_id) : null;
  if (jobActive(running, now)) return { kind: "started", job: running! };
  return { kind: "started", job: await startJob(ticker, lang, "manual", schedule, now) };
}

export async function listVersions(ticker: string, lang: Lang) {
  const idx = await getStockStore().getIndex(ticker, lang);
  return (idx?.versions ?? []).slice().reverse();
}

/** Daily refresh of tracked tickers whose latest version is stale or predates a new 10-K/10-Q/8-K. */
export async function cronRefresh(now = new Date()): Promise<{ checked: number; refreshed: string[]; skipped: string[] }> {
  const store = getStockStore();
  const tracked = await store.listTracked();
  const due: { ticker: string; language: Lang; at: string }[] = [];
  const skipped: string[] = [];
  for (const t of tracked) {
    const idx = await store.getIndex(t.ticker, t.language);
    const latest = idx?.versions.at(-1);
    const job = idx?.latest_job_id ? await store.getJob(idx.latest_job_id) : null;
    if (jobActive(job, now)) {
      skipped.push(`${t.ticker}/${t.language}:running`);
      continue;
    }
    let sub: Submissions | null = null;
    try {
      sub = (await resolveEntity(t.ticker)).submissions;
    } catch {
      skipped.push(`${t.ticker}/${t.language}:unresolved`);
      continue;
    }
    if (!isFresh(latest, sub, now)) due.push({ ...t, at: latest?.generated_at ?? "" });
  }
  due.sort((a, b) => a.at.localeCompare(b.at));
  const pick = due.slice(0, BB_CONFIG.cronMaxTickers);
  const runs: Promise<unknown>[] = [];
  for (const t of pick) await startJob(t.ticker, t.language, "cron", (task) => runs.push(task()), now);
  await Promise.allSettled(runs);
  for (const t of due.slice(BB_CONFIG.cronMaxTickers)) skipped.push(`${t.ticker}/${t.language}:deferred`);
  return { checked: tracked.length, refreshed: pick.map((t) => `${t.ticker}/${t.language}`), skipped };
}
