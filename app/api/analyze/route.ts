import { NextResponse } from "next/server";
import { analyze } from "@/lib/pipeline";
import type { BreakoutInput, BreakoutPattern } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function parseBreakout(b: unknown): BreakoutInput | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const pattern = String(o.pattern ?? "").toUpperCase() as BreakoutPattern;
  if (!["PEAK", "CENTER", "BOTTOM"].includes(pattern)) return null;
  const high = Number(o.breakout_high);
  return {
    confirmed_by_user: o.confirmed_by_user !== false,
    pattern,
    breakout_date: String(o.breakout_date ?? "").slice(0, 10),
    breakout_high: Number.isFinite(high) ? high : 0,
  };
}

async function handle(params: { ticker?: string; as_of?: string | null; breakout?: unknown; threshold?: unknown }) {
  const ticker = (params.ticker ?? "").trim();
  if (!ticker || ticker.length > 12) {
    return NextResponse.json({ error: "Provide a ticker (e.g. ?ticker=AAPL)" }, { status: 400 });
  }
  try {
    const thr = Number(params.threshold);
    const report = await analyze({
      ticker,
      asOf: params.as_of || null,
      breakout: parseBreakout(params.breakout),
      threshold: Number.isFinite(thr) && thr > 0 && thr < 1 ? thr : undefined,
    });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || "Analysis failed";
    const status = /not found|Empty ticker|Invalid/.test(msg) ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const pattern = u.searchParams.get("pattern");
  return handle({
    ticker: u.searchParams.get("ticker") ?? undefined,
    as_of: u.searchParams.get("as_of"),
    threshold: u.searchParams.get("threshold"),
    breakout: pattern
      ? {
          pattern,
          breakout_date: u.searchParams.get("breakout_date"),
          breakout_high: u.searchParams.get("breakout_high"),
        }
      : null,
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return handle({
    ticker: body.ticker as string,
    as_of: (body.as_of as string) ?? null,
    breakout: body.breakout,
    threshold: body.threshold,
  });
}
