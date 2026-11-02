import type { Quality } from './types.js';

export type KnownSource = 'qobuzdl' | 'lastbabe' | 'monochrome' | 'deezer' | 'eljohnzc' | 'instable';
export const QUALITY_TIERS: readonly Quality[] = ['HI_RES', 'LOSSLESS', 'HIGH', 'LOW'];
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
  instableQualityHiRes?: string;
  instableQualityLossless?: string;
  instableQualityHigh?: string;
  instableQualityLow?: string;
  instableApiToken?: string;
  instableUserAgent?: string;
  enabledSources: Set<KnownSource>;
  sourceSearchTimeoutMs: number;
  sourceHealthTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitMaxKeys: number;
  maxQueryLength: number;
  allowDownloads: boolean;
  checkValidLossless: boolean;
  requireBitChordUserAgent: boolean;
  allowSignedUiSession: boolean;
  uiSessionTtlSeconds: number;
  userAgent: string;
  proxyWebMedia: boolean;
  directStreamBitChord: boolean;
  directStreamLastWave: boolean;
  downloadSources: Set<KnownSource>;
  enabledQualityTiers: Set<Quality>;
}

const DEV_ID_SECRET = 'qobuz-bitchord-id-secret-dev-only';

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
};

const nonNegativeInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
};

export function parseZeroOneFlag(raw: string | undefined, fallback = false): boolean {
  const normalized = raw?.trim();
  if (normalized === '1') return true;
  if (normalized === '0') return false;
  return fallback;
}

function parseEnabledSources(raw?: string): Set<KnownSource> {
  const trimmed = (raw ?? 'instable').trim();
  const parts = trimmed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is KnownSource => (KNOWN_SOURCES as readonly string[]).includes(s));
  return new Set(parts);
}

export function parseDisabledQualityTiers(raw?: string): Set<Quality> {
  const aliases: Record<string, Quality> = {
    HI_RES: 'HI_RES', HIRES: 'HI_RES', HI_RES_LOSSLESS: 'HI_RES', HIRES_LOSSLESS: 'HI_RES',
    LOSSLESS: 'LOSSLESS', FLAC: 'LOSSLESS', ATMOS: 'LOSSLESS', DOLBY_ATMOS: 'LOSSLESS',
    HIGH: 'HIGH', LOW: 'LOW',
  };
  const disabled = new Set<Quality>();
  for (const part of (raw ?? '').split(',')) {
    const normalized = part.trim().toUpperCase().replace(/[\s-]+/g, '_');
    const tier = aliases[normalized];
    if (tier) disabled.add(tier);
  }
  return disabled;
}

export function parseEnabledQualityTiers(raw?: string): Set<Quality> {
  const disabled = parseDisabledQualityTiers(raw);
  const enabled = new Set(QUALITY_TIERS.filter((tier) => !disabled.has(tier)));
  // Keep one usable tier if an operator accidentally disables every tier.
  if (enabled.size === 0) enabled.add('LOSSLESS');
  return enabled;
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
  const requestTimeoutMs = positiveInt('REQUEST_TIMEOUT_MS', 6000);
  const serverRequestTimeoutMs = positiveInt('SERVER_REQUEST_TIMEOUT_MS', 10_000);
  // Instable can legitimately take several seconds on a cache miss. Keep the
  // source deadline below the upstream request ceiling without turning a slow
  // but healthy search into a 500 response.
  const sourceSearchTimeoutMs = Math.min(positiveInt('SOURCE_SEARCH_TIMEOUT_MS', 5000), requestTimeoutMs);

  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: positiveInt('PORT', Number(process.env.SERVER_PORT) || 3000),
    requestTimeoutMs,
    serverRequestTimeoutMs,
    // Zero is intentional: it disables retries and prevents a public burst
    // from multiplying traffic to the upstream provider.
    upstreamRetries: nonNegativeInt('UPSTREAM_RETRIES', 1),
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
    instableQualityHiRes: process.env.INSTABLE_QUALITY_HI_RES?.trim(),
    instableQualityLossless: process.env.INSTABLE_QUALITY_LOSSLESS?.trim(),
    instableQualityHigh: process.env.INSTABLE_QUALITY_HIGH?.trim(),
    instableQualityLow: process.env.INSTABLE_QUALITY_LOW?.trim(),
    instableApiToken: process.env.INSTABLE_API_TOKEN?.trim(),
    instableUserAgent: process.env.INSTABLE_USER_AGENT?.trim(),
    enabledSources: parseEnabledSources(process.env.QOBUZ_ENABLED_SOURCES),
    sourceSearchTimeoutMs,
    sourceHealthTimeoutMs: positiveInt(
      'SOURCE_HEALTH_TIMEOUT_MS',
      Math.min(requestTimeoutMs, serverRequestTimeoutMs),
    ),
    rateLimitWindowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMaxRequests: positiveInt('RATE_LIMIT_MAX_REQUESTS', 60),
    rateLimitMaxKeys: positiveInt('RATE_LIMIT_MAX_KEYS', 10_000),
    maxQueryLength: positiveInt('MAX_QUERY_LENGTH', 200),
    allowDownloads: (process.env.EMIKA_ALLOW_DOWNLOADS ?? '').trim().toLowerCase() === 'true',
    checkValidLossless: parseZeroOneFlag(process.env.EMIKA_CHECK_VALID_LOSSLESS),
    requireBitChordUserAgent: parseZeroOneFlag(process.env.EMIKA_REQUIRE_BITCHORD_USER_AGENT),
    allowSignedUiSession: parseZeroOneFlag(process.env.EMIKA_ALLOW_SIGNED_UI_SESSION),
    uiSessionTtlSeconds: positiveInt('EMIKA_UI_SESSION_TTL_SECONDS', 3600),
    userAgent: process.env.EMIKA_USER_AGENT?.trim() || 'BitChord/v1.9',
    proxyWebMedia: parseZeroOneFlag(process.env.EMIKA_PROXY_WEB_MEDIA, true),
    directStreamBitChord: parseZeroOneFlag(process.env.EMIKA_DIRECT_STREAM_BITCHORD),
    directStreamLastWave: parseZeroOneFlag(process.env.EMIKA_DIRECT_STREAM_LASTWAVE),
    downloadSources: parseEnabledSources(process.env.EMIKA_DOWNLOAD_SOURCES ?? ''),
    enabledQualityTiers: parseEnabledQualityTiers(process.env.EMIKA_DISABLED_QUALITY_TIERS),
  };
}
