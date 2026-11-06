import { fetchWithTimeout } from "./http";
import type { MarketContext } from "./types";

/**
 * Market data provider.
 *
 * Uses Yahoo Finance's public chart endpoint as a development data source.
 * The product spec is explicit that Yahoo is NOT licensed for commercial
 * production use — swap `fetchBars` for a licensed feed (Polygon, Databento,
 * Nasdaq Data Link, etc.) before selling the product. Everything downstream
 * consumes the normalized `Bar[]` shape only.
 */
export interface Bar {
  date: string;
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const MARKET_PROVIDER = "Yahoo Finance chart API (dev-only, unlicensed — replace for production)";

async function fetchBars(symbol: string, asOf: Date, days = 120): Promise<Bar[]> {
  const p2 = Math.floor(asOf.getTime() / 1000) + 3600;
  const p1 = p2 - days * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false`;
  const res = await fetchWithTimeout(url, {
    timeoutMs: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; M-Ticker/0.1)", Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`market data ${res.status} for ${symbol}`);
  const j = (await res.json()) as {
    chart: {
      result?: {
        timestamp?: number[];
        indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
      }[];
      error?: { description?: string } | null;
    };
  };
  const r = j.chart.result?.[0];
  if (!r || !r.timestamp) throw new Error(j.chart.error?.description || `no bars for ${symbol}`);
  const q = r.indicators.quote[0];
  const bars: Bar[] = [];
  r.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || h == null || l == null || c == null) return;
    if (t * 1000 > asOf.getTime()) return; // point-in-time
    bars.push({ t: t * 1000, date: new Date(t * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: v ?? 0 });
  });
  return bars;
}

function pct(a: number, b: number) {
  return b ? ((a - b) / b) * 100 : 0;
}

function dayMove(bars: Bar[]): number | null {
  if (bars.length < 2) return null;
  return pct(bars[bars.length - 1].close, bars[bars.length - 2].close);
}

export async function getMarketContext(ticker: string, sectorEtf: string, asOf: Date): Promise<MarketContext> {
  const empty: MarketContext = {
    available: false,
    provider: MARKET_PROVIDER,
    last_price: null,
    prev_close: null,
    stock_move_pct: null,
    stock_gap_pct: null,
    sector_etf: sectorEtf,
    sector_move_pct: null,
    spy_move_pct: null,
    qqq_move_pct: null,
    relative_return_to_sector: null,
    relative_volume: null,
    volume_vs_20d: null,
    atr_pct: null,
    gap_vs_atr: null,
    d0_high: null,
    bar_date: null,
    history: [],
  };
  const sym = ticker.replace(".", "-");
  const [stock, sector, spy, qqq] = await Promise.allSettled([
    fetchBars(sym, asOf),
    fetchBars(sectorEtf, asOf, 15),
    fetchBars("SPY", asOf, 15),
    fetchBars("QQQ", asOf, 15),
  ]);
  if (stock.status !== "fulfilled" || stock.value.length < 3) {
    return { ...empty, error: stock.status === "rejected" ? String(stock.reason?.message ?? stock.reason) : "insufficient bars" };
  }
  const b = stock.value;
  const last = b[b.length - 1];
  const prev = b[b.length - 2];
  const prior20 = b.slice(-21, -1);
  const avgVol20 = prior20.reduce((s, x) => s + x.volume, 0) / Math.max(1, prior20.length);
  // ATR(14) on the bars before today
  const trs: number[] = [];
  for (let i = Math.max(1, b.length - 15); i < b.length - 1; i++) {
    const c0 = b[i - 1].close;
    trs.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - c0), Math.abs(b[i].low - c0)));
  }
  const atr = trs.length ? trs.reduce((s, x) => s + x, 0) / trs.length : null;
  const atrPct = atr ? (atr / prev.close) * 100 : null;
  const move = pct(last.close, prev.close);
  const gap = pct(last.open, prev.close);
  const sectorMove = sector.status === "fulfilled" ? dayMove(sector.value) : null;
  const rvol = avgVol20 > 0 ? last.volume / avgVol20 : null;
  return {
    available: true,
    provider: MARKET_PROVIDER,
    last_price: last.close,
    prev_close: prev.close,
    stock_move_pct: move,
    stock_gap_pct: gap,
    sector_etf: sectorEtf,
    sector_move_pct: sectorMove,
    spy_move_pct: spy.status === "fulfilled" ? dayMove(spy.value) : null,
    qqq_move_pct: qqq.status === "fulfilled" ? dayMove(qqq.value) : null,
    relative_return_to_sector: sectorMove !== null ? move - sectorMove : null,
    relative_volume: rvol,
    volume_vs_20d: rvol,
    atr_pct: atrPct,
    gap_vs_atr: atr ? (last.open - prev.close) / atr : null,
    d0_high: last.high,
    bar_date: last.date,
    history: b.slice(-60).map(({ date, open, high, low, close, volume }) => ({ date, open, high, low, close, volume })),
  };
}
