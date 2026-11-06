/** Map an SEC SIC code to a broad sector and a liquid sector/industry ETF benchmark. */
export function sectorFromSic(sicRaw: string | null | undefined): { sector: string | null; etf: string } {
  const sic = Number(sicRaw);
  if (!Number.isFinite(sic) || sic <= 0) return { sector: null, etf: "SPY" };
  const r = (a: number, b: number) => sic >= a && sic <= b;
  if (r(2833, 2836) || r(8731, 8731)) return { sector: "Biotech / Pharma", etf: "XBI" };
  if (r(3841, 3851) || r(8000, 8099)) return { sector: "Healthcare", etf: "XLV" };
  if (r(3674, 3674)) return { sector: "Semiconductors", etf: "SMH" };
  if (r(3570, 3579) || r(3660, 3679) || r(7370, 7379) || r(3820, 3829)) return { sector: "Technology", etf: "XLK" };
  if (r(4800, 4899) || r(2710, 2799) || r(7810, 7819)) return { sector: "Communication Services", etf: "XLC" };
  if (r(6798, 6798) || r(6500, 6553)) return { sector: "Real Estate", etf: "XLRE" };
  if (r(6000, 6799)) return { sector: "Financials", etf: "XLF" };
  if (r(1300, 1399) || r(2900, 2999)) return { sector: "Energy", etf: "XLE" };
  if (r(4900, 4949)) return { sector: "Utilities", etf: "XLU" };
  if (r(1000, 1499) || r(2600, 2699) || r(2800, 2829) || r(2840, 2899) || r(3300, 3399)) return { sector: "Materials", etf: "XLB" };
  if (r(2000, 2199) || r(5400, 5499) || r(2840, 2844)) return { sector: "Consumer Staples", etf: "XLP" };
  if (r(3710, 3716) || r(5000, 5999) || r(7000, 7099) || r(5800, 5899) || r(2300, 2399) || r(3940, 3949)) return { sector: "Consumer Discretionary", etf: "XLY" };
  if (r(3720, 3729) || r(3760, 3769)) return { sector: "Aerospace & Defense", etf: "ITA" };
  if (r(1500, 1799) || r(3400, 3569) || r(3580, 3659) || r(4000, 4799) || r(3700, 3799) || r(8700, 8799)) return { sector: "Industrials", etf: "XLI" };
  return { sector: "Other", etf: "SPY" };
}
