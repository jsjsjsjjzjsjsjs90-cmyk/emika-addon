export type KnownSource = 'qobuzdl' | 'lastbabe' | 'monochrome' | 'deezer' | 'eljohnzc' | 'instable';
const KNOWN_SOURCES: readonly KnownSource[] = [
  'qobuzdl', 'lastbabe', 'monochrome', 'deezer', 'eljohnzc', 'instable',
];

export interface Config {
  host: string;
  port: number;
  requestTimeoutMs: number;
  serverRequestTimeoutMs: number;
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
  instableSearchPath?: string;
  instableStreamPath?: string;
  instableSource?: string;
  instableSendSource?: boolean;
  instableQualityLossless?: string;
  instableQualityHigh?: string;
  instableQualityLow?: string;
  instableApiToken?: string;
  instableUserAgent?: string;
  enabledSources: Set<KnownSource>;
  sourceSearchTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitMaxKeys: number;
  maxQueryLength: number;
}

const DEV_ID_SECRET = 'qobuz-bitchord-id-secret-dev-only';

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
};

function parseEnabledSources(raw?: string): Set<KnownSource> {
  const trimmed = (raw ?? 'qobuzdl,eljohnzc,instable').trim();
  const parts = trimmed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is KnownSource => (KNOWN_SOURCES as readonly string[]).includes(s));
  return new Set(parts);
}

export function loadConfig(): Config {
  const providerRaw = (process.env.QOBUZ_PROVIDER ?? 'multi').trim().toLowerCase();
  const provider: Config['provider'] =
    providerRaw === 'stub' || providerRaw === 'http' || providerRaw === 'qobuzdl' || providerRaw === 'multi'
      ? providerRaw
      : 'multi';

  const apiBaseUrl =
    process.env.QOBUZ_API_BASE_URL?.trim() ||
    process.env.QOBUZ_UPSTREAM_BASE_URL?.trim() ||
    'https://qobuz-dll.foreyou.workers.dev';

  const secretEnv = process.env.QOBUZ_ID_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (!secretEnv && isProduction) {
    throw new Error('QOBUZ_ID_SECRET is required in production');
  }

  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: positiveInt('PORT', Number(process.env.SERVER_PORT) || 3000),
    requestTimeoutMs: positiveInt('REQUEST_TIMEOUT_MS', 6000),
    serverRequestTimeoutMs: positiveInt('SERVER_REQUEST_TIMEOUT_MS', 10_000),
    upstreamRetries: positiveInt('UPSTREAM_RETRIES', 1),
    cacheTtlMs: positiveInt('CACHE_TTL_SECONDS', 300) * 1000,
    idSecret: secretEnv || DEV_ID_SECRET,
    provider,
    apiBaseUrl,
    searchPath: process.env.QOBUZ_SEARCH_PATH,
    streamPath: process.env.QOBUZ_STREAM_PATH,
    apiToken: process.env.QOBUZ_API_TOKEN,
    lastBabeBaseUrl: process.env.LASTBABE_BASE_URL?.trim() || 'https://lastbabe.velixir.run',
    monochromeBaseUrl: process.env.MONOCHROME_BASE_URL?.trim() || 'https://tracks.monochrome.st',
    deezerBaseUrl: process.env.DEEZER_BASE_URL?.trim() || 'https://bitchord-hires-addon.vercel.app',
    eljohnzcBaseUrl:
      process.env.ELJOHNZC_BASE_URL?.trim() ||
      'https://gglos.geisselgottes.cfd/u/eyJ2IjoxLCJzcmMiOlsicSJdLCJxIjpbIkxPU1NMRVNTIiwiSElHSCIsIkxPVyJdLCJhdG1vcyI6Im9mZiIsImhpZGUiOnsibWluU2VjIjozMH19',
    instableBaseUrl: process.env.INSTABLE_BASE_URL?.trim() || 'https://instable.arcod.xyz',
    instableSearchPath: process.env.INSTABLE_SEARCH_PATH?.trim(),
    instableStreamPath: process.env.INSTABLE_STREAM_PATH?.trim(),
    instableSource: process.env.INSTABLE_SOURCE?.trim(),
    instableSendSource: (process.env.INSTABLE_SEND_SOURCE ?? '').trim().toLowerCase() === 'true',
    instableQualityLossless: process.env.INSTABLE_QUALITY_LOSSLESS?.trim(),
    instableQualityHigh: process.env.INSTABLE_QUALITY_HIGH?.trim(),
    instableQualityLow: process.env.INSTABLE_QUALITY_LOW?.trim(),
    instableApiToken: process.env.INSTABLE_API_TOKEN?.trim(),
    instableUserAgent: process.env.INSTABLE_USER_AGENT?.trim(),
    enabledSources: parseEnabledSources(process.env.QOBUZ_ENABLED_SOURCES),
    sourceSearchTimeoutMs: positiveInt('SOURCE_SEARCH_TIMEOUT_MS', 3000),
    rateLimitWindowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMaxRequests: positiveInt('RATE_LIMIT_MAX_REQUESTS', 60),
    rateLimitMaxKeys: positiveInt('RATE_LIMIT_MAX_KEYS', 10_000),
    maxQueryLength: positiveInt('MAX_QUERY_LENGTH', 200),
  };
}
