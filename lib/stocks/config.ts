/** Bull/Bear feature configuration — every lookback and threshold is a setting, not a constant in code. */
const num = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const BB_CONFIG = {
  officialLookbackMonths: num("BB_OFFICIAL_LOOKBACK_MONTHS", 36),
  newsLookbackDays: num("BB_NEWS_LOOKBACK_DAYS", 90),
  socialLookbackDays: num("BB_SOCIAL_LOOKBACK_DAYS", 30),
  freshHours: num("BB_FRESH_HOURS", 24),
  manualRefreshMinutes: num("BB_MANUAL_REFRESH_MINUTES", 60),
  jobStaleMinutes: num("BB_JOB_STALE_MINUTES", 10),
  strongThreshold: num("BB_STRONG_THRESHOLD", 6),
  mediumThreshold: num("BB_MEDIUM_THRESHOLD", 3),
  minArgumentsPerSide: num("BB_MIN_ARGUMENTS", 3),
  maxArgumentsPerSide: num("BB_MAX_ARGUMENTS", 7),
  titleMaxWords: num("BB_TITLE_MAX_WORDS", 15),
  excerptMaxChars: num("BB_EXCERPT_MAX_CHARS", 300),
  cronMaxTickers: num("BB_CRON_MAX_TICKERS", 5),
};

export const SOURCE_WEIGHT = { official: 3, news: 2, social: 1 } as const;

/** Recency factor: 1.0 up to 3 months, 0.7 up to 1 year, 0.4 beyond. */
export function recencyFactor(publishedAt: string | null, at: Date): number {
  if (!publishedAt) return 0.4;
  const days = (at.getTime() - Date.parse(publishedAt)) / 86400e3;
  if (days <= 92) return 1.0;
  if (days <= 366) return 0.7;
  return 0.4;
}
