import { createHash } from "node:crypto";
import type { Lang } from "./store";

export const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;

export function normTicker(raw: string): string | null {
  const t = decodeURIComponent(raw).trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}

/** Spec: output in Hebrew. `lang=en` is accepted for English-language UIs. */
export function langFrom(params: URLSearchParams): Lang {
  return params.get("lang") === "en" ? "en" : "he";
}

/** Rate-limit identity: the app's anonymous client id when sent, else the caller's IP — hashed, never stored raw. */
export function clientKey(req: Request): string {
  const id = req.headers.get("x-client-id");
  const raw = id && /^[A-Za-z0-9-]{8,64}$/.test(id) ? `c:${id}` : `ip:${(req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown"}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}
