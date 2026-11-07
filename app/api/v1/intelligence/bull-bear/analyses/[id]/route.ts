import { NextResponse } from "next/server";
import { getStore } from "@/lib/research/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9._\-]{1,80}$/.test(id)) return NextResponse.json({ error: "Invalid analysis id" }, { status: 400 });
  const a = await getStore().get(id);
  if (!a) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  return NextResponse.json(a, { headers: { "Cache-Control": "no-store" } });
}
