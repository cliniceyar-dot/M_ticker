import { after, NextResponse } from "next/server";
import { manualRefresh, NotFoundError } from "@/lib/stocks/service";
import { clientKey, langFrom, normTicker } from "@/lib/stocks/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manual refresh; 429 when called again within the rate-limit window. */
export async function POST(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const ticker = normTicker((await ctx.params).ticker);
  if (!ticker) return NextResponse.json({ error: "Invalid ticker" }, { status: 400 });
  try {
    const r = await manualRefresh(ticker, langFrom(new URL(req.url).searchParams), clientKey(req), (task) => after(task));
    if (r.kind === "rate_limited") {
      return NextResponse.json(
        { error: "Manual refresh is limited to once per hour", retry_after_seconds: r.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } },
      );
    }
    return NextResponse.json(
      { status: r.job.status, job_id: r.job.job_id, links: { job: `/api/v1/jobs/${r.job.job_id}` } },
      { status: 202, headers: { Location: `/api/v1/jobs/${r.job.job_id}` } },
    );
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    return NextResponse.json({ error: (e as Error).message || "Refresh failed" }, { status: 502 });
  }
}
