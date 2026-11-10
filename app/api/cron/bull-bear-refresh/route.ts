import { NextResponse } from "next/server";
import { cronRefresh } from "@/lib/stocks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily automatic refresh (Vercel Cron). Requires `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const isVercelCron = (req.headers.get("user-agent") ?? "").startsWith("vercel-cron/");
  if (secret ? auth !== `Bearer ${secret}` : !isVercelCron) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await cronRefresh();
  console.log(JSON.stringify({ evt: "bull_bear_cron", ...result }));
  return NextResponse.json(result);
}
