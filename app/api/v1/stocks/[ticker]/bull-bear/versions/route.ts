import { NextResponse } from "next/server";
import { listVersions } from "@/lib/stocks/service";
import { langFrom, normTicker } from "@/lib/stocks/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Past analysis versions, newest first (internal/admin). Fetch one with GET …/bull-bear?version=N. */
export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const ticker = normTicker((await ctx.params).ticker);
  if (!ticker) return NextResponse.json({ error: "Invalid ticker" }, { status: 400 });
  const lang = langFrom(new URL(req.url).searchParams);
  return NextResponse.json({ ticker, language: lang, versions: await listVersions(ticker, lang) }, { headers: { "Cache-Control": "no-store" } });
}
