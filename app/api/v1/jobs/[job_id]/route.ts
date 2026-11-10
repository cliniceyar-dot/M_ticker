import { NextResponse } from "next/server";
import { getStockStore } from "@/lib/stocks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Job status: queued / running / done / failed, with per-source progress. */
export async function GET(_req: Request, ctx: { params: Promise<{ job_id: string }> }) {
  const { job_id } = await ctx.params;
  if (!/^job_[A-Z0-9.\-]{1,12}_\d{8}T\d{6}Z_[a-z0-9]{6}$/.test(job_id)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = await getStockStore().getJob(job_id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const lang = job.language === "en" ? "&lang=en" : "";
  return NextResponse.json(
    {
      job_id: job.job_id,
      ticker: job.ticker,
      status: job.status,
      progress: job.progress,
      attempts: job.attempts,
      error: job.error,
      version: job.version,
      created_at: job.created_at,
      updated_at: job.updated_at,
      links: job.status === "done" ? { result: `/api/v1/stocks/${job.ticker}/bull-bear?version=${job.version}${lang}` } : {},
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
