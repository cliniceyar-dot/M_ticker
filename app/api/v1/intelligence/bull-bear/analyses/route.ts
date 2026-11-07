import { after, NextResponse } from "next/server";
import { getStore, newAnalysisId } from "@/lib/research/store";
import { newAnalysis, runBullBear } from "@/lib/research/pipeline";
import { DEFAULT_OPTIONS, type AnalysisOptions } from "@/lib/research/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parseOptions(raw: unknown): AnalysisOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const d = DEFAULT_OPTIONS;
  return {
    company_history_months: int(o.company_history_months, d.company_history_months, 6, 60),
    recent_media_months: int(o.recent_media_months, d.recent_media_months, 1, 12),
    include_sec: bool(o.include_sec, d.include_sec),
    include_strategy: bool(o.include_strategy, d.include_strategy),
    include_news: bool(o.include_news, d.include_news),
    include_youtube: bool(o.include_youtube, d.include_youtube),
    include_x: bool(o.include_x, d.include_x),
    include_instagram: bool(o.include_instagram, d.include_instagram),
  };
}

/** Start a Bullish vs. Bearish analysis. Returns 202 immediately; work continues in the background. */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ticker = String(body.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return NextResponse.json({ error: "Provide a valid ticker" }, { status: 400 });
  const now = new Date();
  const asOf = body.as_of ? new Date(String(body.as_of)) : now;
  if (Number.isNaN(asOf.getTime())) return NextResponse.json({ error: "Invalid as_of timestamp" }, { status: 400 });
  const clamped = asOf > now ? now : asOf;

  const id = newAnalysisId(ticker, now);
  const analysis = newAnalysis(id, ticker, clamped, parseOptions(body.options));
  await getStore().save(analysis);
  after(() => runBullBear(analysis));
  return NextResponse.json(
    { analysis_id: id, status: analysis.status, ticker, as_of: analysis.as_of, links: { self: `/api/v1/intelligence/bull-bear/analyses/${id}` } },
    { status: 202, headers: { Location: `/api/v1/intelligence/bull-bear/analyses/${id}` } },
  );
}

/** Analysis history for a ticker: GET ?ticker=NVDA */
export async function GET(req: Request) {
  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase() ?? "";
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return NextResponse.json({ error: "Provide ?ticker=" }, { status: 400 });
  const items = await getStore().listByTicker(ticker, 25);
  return NextResponse.json({ ticker, analyses: items }, { headers: { "Cache-Control": "no-store" } });
}
