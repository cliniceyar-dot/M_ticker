import { after, NextResponse } from "next/server";
import { getBullBear, NotFoundError } from "@/lib/stocks/service";
import { parseFilters } from "@/lib/stocks/spec";
import { langFrom, normTicker } from "@/lib/stocks/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Latest analysis: 200 with body, or 202 + job_id while generating. Query: source_types, from, to, lang, version. */
export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const ticker = normTicker((await ctx.params).ticker);
  if (!ticker) return NextResponse.json({ error: "Invalid ticker" }, { status: 400 });
  const params = new URL(req.url).searchParams;
  const filters = parseFilters(params);
  if ("error" in filters) return NextResponse.json({ error: filters.error }, { status: 400 });
  const version = params.get("version") ? Number(params.get("version")) : undefined;
  if (version !== undefined && !(Number.isInteger(version) && version > 0)) return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  try {
    const r = await getBullBear(ticker, langFrom(params), filters, (task) => after(task), { version });
    if (r.kind === "ready") return NextResponse.json(r.body, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(
      { status: r.job.status, job_id: r.job.job_id, links: { job: `/api/v1/jobs/${r.job.job_id}` }, previous: r.previous },
      { status: 202, headers: { Location: `/api/v1/jobs/${r.job.job_id}`, "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    return NextResponse.json({ error: (e as Error).message || "Analysis failed" }, { status: 502 });
  }
}
