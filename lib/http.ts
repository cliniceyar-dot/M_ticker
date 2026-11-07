export const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT?.trim() || "M-Ticker Research App (set SEC_USER_AGENT)";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 12000, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// SEC fair-access: <= 10 requests/second with a declared User-Agent.
// A tiny serial gate keeps us well under the limit within a single invocation.
let secChain: Promise<unknown> = Promise.resolve();
const SEC_MIN_GAP_MS = 120;

export function secFetch(url: string, timeoutMs = 12000): Promise<Response> {
  const run = secChain.then(async () => {
    const res = await fetchWithTimeout(url, {
      timeoutMs,
      headers: {
        "User-Agent": SEC_USER_AGENT,
        "Accept-Encoding": "gzip, deflate",
        Accept: "application/json, text/html, application/xml, */*",
      },
      cache: "no-store",
    });
    await new Promise((r) => setTimeout(r, SEC_MIN_GAP_MS));
    return res;
  });
  secChain = run.catch(() => undefined);
  return run;
}

export async function secJson<T>(url: string): Promise<T> {
  const res = await secFetch(url);
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function secText(url: string): Promise<string> {
  const res = await secFetch(url);
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return await res.text();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
