export interface Config {
  host: string;
  port: number;
  requestTimeoutMs: number;
  upstreamRetries: number;
  cacheTtlMs: number;
  idSecret: string;
  provider: 'stub' | 'http' | 'qobuzdl' | 'multi';
  apiBaseUrl?: string;
  searchPath?: string;
  streamPath?: string;
  apiToken?: string;
  lastBabeBaseUrl?: string;
  monochromeBaseUrl?: string;
  deezerBaseUrl?: string;
  eljohnzcBaseUrl?: string;
  instableBaseUrl?: string;
  // Instable overrides (all optional)
  instableSearchPath?: string;
  instableStreamPath?: string;
  instableSource?: string;
  instableSendSource?: boolean;
  instableQualityLossless?: string;
  instableQualityHigh?: string;
  instableQualityLow?: string;
  instableApiToken?: string;
  instableUserAgent?: string;
}

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback; // ถ้าว่างให้ใช้ Default
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback; // ถ้าค่าผิดให้ใช้ Default
  return value;
};

export function loadConfig(): Config {
  const providerRaw = (process.env.QOBUZ_PROVIDER ?? 'multi').trim().toLowerCase();
  const provider = (providerRaw === 'stub' || providerRaw === 'http' || providerRaw === 'qobuzdl' || providerRaw === 'multi') ? providerRaw : 'multi';

  const apiBaseUrl = process.env.QOBUZ_API_BASE_URL?.trim() || process.env.QOBUZ_UPSTREAM_BASE_URL?.trim() || 'https://qobuz-dll.foreyou.workers.dev';

  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: positiveInt('PORT', Number(process.env.SERVER_PORT) || 3000),
    requestTimeoutMs: positiveInt('REQUEST_TIMEOUT_MS', 6000),
    upstreamRetries: positiveInt('UPSTREAM_RETRIES', 1),
    cacheTtlMs: positiveInt('CACHE_TTL_SECONDS', 300) * 1000,
    idSecret: process.env.QOBUZ_ID_SECRET?.trim() || 'qobuz-bitchord-id-secret-v1',
    provider,
    apiBaseUrl,
    searchPath: process.env.QOBUZ_SEARCH_PATH,
    streamPath: process.env.QOBUZ_STREAM_PATH,
    apiToken: process.env.QOBUZ_API_TOKEN,
    lastBabeBaseUrl: process.env.LASTBABE_BASE_URL?.trim() || 'https://lastbabe.velixir.run',
    monochromeBaseUrl: process.env.MONOCHROME_BASE_URL?.trim() || 'https://tracks.monochrome.st',
    deezerBaseUrl: process.env.DEEZER_BASE_URL?.trim() || 'https://bitchord-hires-addon.vercel.app',
    eljohnzcBaseUrl: process.env.ELJOHNZC_BASE_URL?.trim() || 'https://eljohnzcaddon.velixir.run/c57e7b0ef2031b2f1fcd',
    instableBaseUrl: process.env.INSTABLE_BASE_URL?.trim() || 'https://instable.arcod.xyz',
    // Instable overrides — undefined if not set, provider uses built-in defaults
    instableSearchPath:      process.env.INSTABLE_SEARCH_PATH?.trim(),
    instableStreamPath:      process.env.INSTABLE_STREAM_PATH?.trim(),
    instableSource:          process.env.INSTABLE_SOURCE?.trim(),
    instableSendSource:      (process.env.INSTABLE_SEND_SOURCE ?? '').trim().toLowerCase() === 'true',
    instableQualityLossless: process.env.INSTABLE_QUALITY_LOSSLESS?.trim(),
    instableQualityHigh:     process.env.INSTABLE_QUALITY_HIGH?.trim(),
    instableQualityLow:      process.env.INSTABLE_QUALITY_LOW?.trim(),
    instableApiToken:        process.env.INSTABLE_API_TOKEN?.trim(),
    instableUserAgent:       process.env.INSTABLE_USER_AGENT?.trim(),
  };
}
