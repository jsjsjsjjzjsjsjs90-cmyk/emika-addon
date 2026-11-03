import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { loadConfig, QUALITY_TIERS } from './config.js';
import { homePage } from './home.js';
import { TtlCache } from './cache.js';
import { AppError, badRequest, notFound } from './errors.js';
import { normalizeTrack, streamResponse, upstreamIdFromPublicId } from './normalize.js';
import { createProvider, createSourceProvider, type IsolatedSource } from './providers/index.js';
import { SlidingWindowRateLimiter, clientKey } from './rate-limit.js';
import { normalizeHealthQuery } from './query.js';
import { createUiSession, readCookie, UI_SESSION_COOKIE, verifyUiSession } from './ui-session.js';
import type { QobuzProvider, Quality, PublicTrack } from './types.js';

const config = loadConfig();
const app = Fastify({
  logger: { redact: ['req.headers.authorization', 'req.headers.cookie', '*.url'] },
  requestTimeout: config.serverRequestTimeoutMs,
});
app.addHook('onSend', async (_request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Accept, Content-Type, Range');
  reply.header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Disposition, Content-Type');
  reply.header('X-Content-Type-Options', 'nosniff');
});
const limiter = new SlidingWindowRateLimiter(config.rateLimitMaxRequests, config.rateLimitWindowMs, config.rateLimitMaxKeys);
app.addHook('onRequest', async (request, reply) => {
  const pathname = request.url.split('?', 1)[0];
  const isAddonResource = pathname.endsWith('/manifest.json') || pathname.includes('/search') || pathname.includes('/stream/') || pathname.includes('/media/') || pathname.includes('/download/');
  const hasBitChordIdentity = isBitChordUserAgent(request.headers['user-agent']);
  const hasUiSession = config.allowSignedUiSession && verifyUiSession(
    readCookie(request.headers.cookie, UI_SESSION_COOKIE),
    config.idSecret,
  );
  if (config.requireBitChordUserAgent && isAddonResource && !hasBitChordIdentity && !hasUiSession) {
    return reply.code(403).send({ error: 'BitChord User-Agent required' });
  }
  if (!pathname.includes('/search') && !pathname.includes('/stream/') && !pathname.includes('/media/') && !pathname.includes('/download/') && pathname !== '/health/sources') return;
  // Fastify/Vercel supplies request.ip from the platform boundary. Do not trust
  // a caller-provided X-Forwarded-For value: it would allow a new bucket per request.
  const result = limiter.check(clientKey(request.ip));
  reply.header('X-RateLimit-Limit', result.limit);
  reply.header('X-RateLimit-Remaining', result.remaining);
  reply.header('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));
  if (!result.allowed) {
    reply.header('Retry-After', Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
    return reply.code(429).send({ error: 'rate limit exceeded' });
  }
});

function isBitChordUserAgent(userAgent: string | undefined): boolean {
  return typeof userAgent === 'string' && /^BitChord\/[\w.-]+$/i.test(userAgent.trim());
}

function isLastWaveUserAgent(userAgent: string | undefined): boolean {
  return typeof userAgent === 'string' && /(?:^|\s)LastWave(?:-(?:Player|Downloader))?\/[\w.-]+(?:\s|$)/i.test(userAgent.trim());
}

function isSupportedNativeUserAgent(userAgent: string | undefined): boolean {
  return isBitChordUserAgent(userAgent) || isLastWaveUserAgent(userAgent);
}

const manifests = {
  root:       { id: 'com.bitchord.qobuz',            name: 'Emika addon',              version: '1.0.0' },
  qobuzdl:    { id: 'com.bitchord.qobuz.qobuzdl',    name: 'Qobuz-DL',                 version: '1.0.0' },
  lastbabe:   { id: 'com.bitchord.qobuz.lastbabe',   name: 'LastBabe',                 version: '1.0.0' },
  monochrome: { id: 'com.bitchord.qobuz.monochrome', name: 'Monochrome Lossless',      version: '1.0.0' },
  deezer:     { id: 'com.bitchord.qobuz.deezer',     name: 'Deezer Fallback',          version: '1.0.0' },
    eljohnzc:   { id: 'com.bitchord.qobuz.eljohnzc',   name: 'Eljohnzc Lossless',        version: '1.0.0' },
    bitchordhires: { id: 'com.bitchord.qobuz.bitchordhires', name: 'BitChord Hi-Res', version: '1.0.0' },
  instable:   { id: 'com.bitchord.qobuz.instable',   name: 'Instable Lossless',        version: '1.0.0' },
} as const;

app.get('/', async (_request, reply) => {
  if (config.allowSignedUiSession) {
    const token = createUiSession(config.idSecret, config.uiSessionTtlSeconds);
    reply.header(
      'Set-Cookie',
      `${UI_SESSION_COOKIE}=${token}; Path=/; Max-Age=${config.uiSessionTtlSeconds}; HttpOnly; Secure; SameSite=Lax`,
    );
  }
  return reply
    .header('Cache-Control', 'private, no-store')
    .type('text/html; charset=utf-8')
    .send(homePage);
});
app.get('/health', async () => ({
  ok: true,
  provider: config.provider,
  enabledSources: [...(config.rootEnabledSources ?? config.enabledSources)],
  configuredSources: [...config.enabledSources],
  timeouts: {
    sourceSearchMs: config.sourceSearchTimeoutMs,
    sourceHealthMs: config.sourceHealthTimeoutMs,
    upstreamMs: config.requestTimeoutMs,
    requestMs: config.serverRequestTimeoutMs,
  },
  allowDownloads: manifestAllowsDownloads(),
  downloadSources: [...config.downloadSources],
}));

app.get<{ Querystring: { q?: string } }>('/health/sources', async (request, reply) => {
  const testQuery = normalizeHealthQuery(request.query.q, config.maxQueryLength);
  const sourceNames: IsolatedSource[] = [
    'qobuzdl', 'lastbabe', 'monochrome', 'deezer', 'eljohnzc', 'bitchordhires', 'instable',
  ];

  const results = await Promise.all(
    sourceNames.map(async (sourceName) => {
      if (!config.enabledSources.has(sourceName)) {
        return {
          source: sourceName,
          status: 'disabled_by_config' as const,
          latencyMs: 0,
          resultCount: 0,
          search: { status: 'not_tested' as const, latencyMs: 0 },
          stream: { status: 'not_tested' as const, latencyMs: 0, attempts: 0 },
        };
      }
      const provider = createSourceProvider(config, sourceName);
      const started = Date.now();
      const healthTimeoutMs = healthTimeoutFor(sourceName);
      try {
        const tracks = await withTimeout(
          provider.search(testQuery, healthQuality(), 'auto'),
          healthTimeoutMs,
        );
        const searchLatencyMs = Date.now() - started;
        if (tracks.length === 0) {
          return {
            source: sourceName,
            status: 'no_results' as const,
            latencyMs: searchLatencyMs,
            resultCount: 0,
            search: { status: 'no_results' as const, latencyMs: searchLatencyMs },
            stream: { status: 'not_tested' as const, latencyMs: 0, attempts: 0 },
          };
        }

        // Keep the full health probe within one deadline. Try a few results so
        // one unplayable first match does not mark an otherwise healthy source down.
        const candidates = tracks.filter((track) => track.upstreamId.trim()).slice(0, 3);
        let streamLatencyMs = 0;
        let attempts = 0;
        let streamHealthy = false;
        for (const track of candidates) {
          const remainingMs = healthTimeoutMs - (Date.now() - started);
          if (remainingMs <= 0) break;
          attempts += 1;
          const streamStarted = Date.now();
          try {
            const stream = await withTimeout(
              provider.getStream(track.upstreamId, healthQuality(), 'auto'),
              remainingMs,
            );
            streamLatencyMs += Date.now() - streamStarted;
            if (stream) {
              try {
                streamResponse(stream, healthQuality());
                streamHealthy = true;
                break;
              } catch {
                // Keep probing another search result from the same source.
              }
            }
          } catch {
            streamLatencyMs += Date.now() - streamStarted;
          }
        }

        const totalLatencyMs = Date.now() - started;
        return {
          source: sourceName,
          status: streamHealthy ? ('healthy' as const) : ('stream_unavailable' as const),
          latencyMs: totalLatencyMs,
          resultCount: tracks.length,
          search: { status: 'healthy' as const, latencyMs: searchLatencyMs },
          stream: {
            status: streamHealthy ? ('healthy' as const) : ('unavailable' as const),
            latencyMs: streamLatencyMs,
            attempts,
          },
        };
      } catch (error) {
        return {
          source: sourceName,
          status: 'unhealthy' as const,
          latencyMs: Date.now() - started,
          resultCount: 0,
          search: {
            status: 'unavailable' as const,
            latencyMs: Date.now() - started,
          },
          stream: { status: 'not_tested' as const, latencyMs: 0, attempts: 0 },
          error: error instanceof Error && error.message === 'operation timed out' ? 'timeout' : 'upstream unavailable',
        };
      }
    }),
  );

  const enabled = results.filter(
    (r) => r.status !== 'disabled_by_config',
  );
  const healthy = enabled.filter((r) => r.status === 'healthy').length;
  const unhealthy = enabled.length - healthy;

  let overallStatus = 'outage';
  if (enabled.length === 0) overallStatus = 'no_sources_enabled';
  else if (healthy === enabled.length) overallStatus = 'all_systems_operational';
  else if (healthy >= Math.ceil(enabled.length / 2)) overallStatus = 'operational_with_minor_outages';
  else if (healthy >= 1) overallStatus = 'degraded_but_functional';

  return reply.header('Cache-Control', 'private, no-store').send({
    timestamp: new Date().toISOString(),
    testQuery,
    overallStatus,
    enabledSources: enabled.length,
    healthySources: healthy,
    unhealthySources: unhealthy,
    totalSources: results.length,
    providers: results,
  });
});

registerAddon('/',    createProvider(config),                     manifests.root);
registerAddon('/a',   createSourceProvider(config, 'qobuzdl'),    manifests.qobuzdl, 'qobuzdl');
registerAddon('/b',   createSourceProvider(config, 'lastbabe'),   manifests.lastbabe, 'lastbabe');
registerAddon('/c',   createSourceProvider(config, 'monochrome'), manifests.monochrome, 'monochrome');
registerAddon('/d',   createSourceProvider(config, 'deezer'),     manifests.deezer,   'deezer');
registerAddon('/e',   createSourceProvider(config, 'eljohnzc'),   manifests.eljohnzc, 'eljohnzc');
registerAddon('/f',   createSourceProvider(config, 'instable'),   manifests.instable, 'instable');
registerAddon('/g',   createSourceProvider(config, 'bitchordhires'), manifests.bitchordhires, 'bitchordhires');

function joinRoute(prefix: string, path: string): string {
  const head = prefix.replace(/\/+$/, '');
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `${head}${tail}` || '/';
}

function registerAddon(
  prefix: string,
  provider: QobuzProvider,
  manifest: { id: string; name: string; version: string },
  namespace?: string,
): void {
  const searchCache = new TtlCache<PublicTrack[]>(config.cacheTtlMs);
  const trackNames = new Map<string, string>();
  const streamCache = new TtlCache<Awaited<ReturnType<QobuzProvider['getStream']>>>(30_000);
  const route = (path: string): string => joinRoute(prefix, path);

  app.get(route('/manifest.json'), async (_request, reply) =>
    reply
      .header(
        'Cache-Control',
        config.requireBitChordUserAgent ? 'private, no-store' : 'public, max-age=3600, s-maxage=86400',
      )
      .send({
        ...manifest,
        description: 'Qobuz lossless and Hi-Res music addon',
        types: ['track'],
        contentType: 'music',
        resources: ['search', 'stream'],
        allowDownloads: manifestAllowsDownloads(namespace) ? 1 : 0,
        checkValidLossless: config.checkValidLossless ? 1 : 0,
        settings: [
          {
            key: 'quality',
            type: 'select',
            default: manifestQualityOptions().find((option) => option.value === 'lossless')?.value
              ?? manifestQualityOptions()[0]?.value
              ?? 'lossless',
            options: manifestQualityOptions(),
          },
        ],
      }),
  );

  app.get<{ Querystring: { q?: string; quality?: string; atmos?: string } }>(
    route('/search'),
    async (request, reply) => {
      const query = request.query.q?.trim();
      if (!query) throw badRequest('q is required');
      if (query.length > config.maxQueryLength) throw badRequest(`q must be at most ${config.maxQueryLength} characters`);
      const quality = parseQuality(request.query.quality);
      assertQualityEnabled(quality);
      const atmos = parseAtmos(request.query.atmos);
      const key = `${query}\u0000${quality}\u0000${atmos}`;

      try {
        const tracks = await searchCache.getOrLoad(key, async () =>
          (await withTimeout(provider.search(query, quality, atmos), searchTimeoutFor(namespace))).flatMap((track) => {
            try {
              return [normalizeTrack(track, config.idSecret, namespace)];
            } catch {
              return [];
            }
          }),
        );
        for (const track of tracks) {
          const baseName = [track.artist, track.title].filter(Boolean).join(' - ') || 'download';
          trackNames.set(track.id, downloadFilename(baseName, track.format));
        }
        while (trackNames.size > 2_000) trackNames.delete(trackNames.keys().next().value as string);
        const responseTracks = isLastWaveUserAgent(request.headers['user-agent'])
          ? tracks.map((track) => {
              if (track.streamURL) return track;
              const forwardedProtocol = request.headers['x-forwarded-proto'];
              const protocol = forwardedProtocol === 'http' ? 'http' : 'https';
              const origin = `${protocol}://${request.headers.host ?? 'localhost'}`;
              const mediaURL = new URL(route(`/media/${encodeURIComponent(track.id)}`), origin);
              mediaURL.searchParams.set('quality', quality.toLowerCase());
              mediaURL.searchParams.set('atmos', atmos);
              mediaURL.searchParams.set('filename', trackNames.get(track.id) ?? 'download.flac');
              return { ...track, streamURL: mediaURL.toString() };
            })
          : tracks;
        const privateSearchResponse = config.requireBitChordUserAgent || isLastWaveUserAgent(request.headers['user-agent']);
        return reply
          .header(
            'Cache-Control',
            privateSearchResponse
              ? 'private, no-store'
              : 'public, max-age=30, s-maxage=300, stale-while-revalidate=600',
          )
          .send({ tracks: responseTracks });
      } catch (error) {
        const stale = searchCache.getStale(key);
        if (stale !== undefined) {
          const privateSearchResponse = config.requireBitChordUserAgent || isLastWaveUserAgent(request.headers['user-agent']);
          return reply
            .header(
              'Cache-Control',
              privateSearchResponse
                ? 'private, no-store'
                : 'public, max-age=10, s-maxage=30, stale-while-revalidate=120',
            )
            .send({ tracks: stale, stale: true });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { quality?: string; atmos?: string; filename?: string } }>(
    route('/stream/:id'),
    async (request, reply) => {
      const quality = parseQuality(request.query.quality);
      assertQualityEnabled(quality);
      const atmos = parseAtmos(request.query.atmos);
      const id = request.params.id;
      if (!/^qobuz_[A-Za-z0-9_-]{10,120}$/.test(id)) throw notFound('track not found');
      const upstreamId = upstreamIdFromPublicId(id, config.idSecret, namespace);
      if (!upstreamId) throw notFound('track not available');
      const stream = await resolveStream(provider, streamCache, upstreamId, quality, atmos);
      if (!stream) throw notFound('track not available');
      try {
        const normalized = streamResponse(stream, quality);
        const filename = downloadFilename(request.query.filename || trackNames.get(id), normalized.format);
        const forwardedProtocol = request.headers['x-forwarded-proto'];
        const protocol = forwardedProtocol === 'http' ? 'http' : 'https';
        const origin = `${protocol}://${request.headers.host ?? 'localhost'}`;
        const userAgent = request.headers['user-agent'];
        const directForNativeClient =
          (config.directStreamBitChord && isBitChordUserAgent(userAgent)) ||
          (config.directStreamLastWave && isLastWaveUserAgent(userAgent));
        if (directForNativeClient || !config.proxyWebMedia) {
          return reply.header('Cache-Control', 'no-store').send({ ...normalized, url: stream.url });
        }
        const mediaUrl = new URL(route(`/media/${encodeURIComponent(id)}`), origin);
        mediaUrl.searchParams.set('quality', quality.toLowerCase());
        mediaUrl.searchParams.set('atmos', atmos);
        mediaUrl.searchParams.set('filename', filename);
        return reply.header('Cache-Control', 'no-store').send({ ...normalized, url: mediaUrl.toString() });
      } catch {
        throw notFound('track has no playable rendition');
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { quality?: string; atmos?: string; filename?: string } }>(
    route('/download/:id'),
    async (request, reply) => {
      if (!manifestAllowsDownloads(namespace)) throw badRequest('downloads are disabled for this addon');
      const quality = parseQuality(request.query.quality);
      assertQualityEnabled(quality);
      const atmos = parseAtmos(request.query.atmos);
      const id = request.params.id;
      if (!/^qobuz_[A-Za-z0-9_-]{10,120}$/.test(id)) throw notFound('track not found');
      const upstreamId = upstreamIdFromPublicId(id, config.idSecret, namespace);
      if (!upstreamId) throw notFound('track not available');
      const stream = await resolveStream(provider, streamCache, upstreamId, quality, atmos);
      if (!stream) throw notFound('track not available');
      const downloadHeaders: Record<string, string> = {};
      if (request.headers.range) downloadHeaders.range = request.headers.range;
      const response = await withTimeout(fetch(stream.url, { headers: downloadHeaders }), config.serverRequestTimeoutMs);
      if (!response.body) throw new AppError(502, 'download is not available');
      if (!response.ok && response.status !== 416) {
        throw new AppError(response.status >= 500 ? 502 : response.status, 'download is not available');
      }
      const filename = downloadFilename(request.query.filename || trackNames.get(id), stream.format);
      const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      reply.code(response.status);
      reply.header('Cache-Control', 'no-store');
      reply.header('Accept-Ranges', response.headers.get('accept-ranges') ?? 'bytes');
      reply.header('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      const length = response.headers.get('content-length');
      if (length) reply.header('Content-Length', length);
      const range = response.headers.get('content-range');
      if (range) reply.header('Content-Range', range);
      return reply.send(Readable.fromWeb(response.body as any));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { quality?: string; atmos?: string; filename?: string } }>(
    route('/media/:id'),
    async (request, reply) => {
      const quality = parseQuality(request.query.quality);
      assertQualityEnabled(quality);
      const atmos = parseAtmos(request.query.atmos);
      const id = request.params.id;
      if (!/^qobuz_[A-Za-z0-9_-]{10,120}$/.test(id)) throw notFound('track not found');
      const upstreamId = upstreamIdFromPublicId(id, config.idSecret, namespace);
      if (!upstreamId) throw notFound('track not available');
      const stream = await resolveStream(provider, streamCache, upstreamId, quality, atmos);
      if (!stream) throw notFound('track not available');
      const headers: Record<string, string> = {};
      if (request.headers.range) headers.range = request.headers.range;
      const response = await withTimeout(fetch(stream.url, { headers }), config.serverRequestTimeoutMs);
      if (!response.body) throw new AppError(502, 'media is not available');
      if (!response.ok && response.status !== 416) {
        throw new AppError(response.status >= 500 ? 502 : response.status, 'media is not available');
      }
      const normalized = streamResponse(stream, quality);
      const filename = downloadFilename(request.query.filename || trackNames.get(id), normalized.format);
      const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      reply.code(response.status);
      reply.header('Cache-Control', 'no-store');
      reply.header('Accept-Ranges', response.headers.get('accept-ranges') ?? 'bytes');
      reply.header('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
      reply.header('Content-Disposition', `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      for (const name of ['content-length', 'content-range']) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      return reply.send(Readable.fromWeb(response.body as any));
    },
  );
}

function manifestAllowsDownloads(namespace?: string): boolean {
  if (!config.allowDownloads || config.downloadSources.size === 0) return false;
  if (namespace) return config.downloadSources.has(namespace as IsolatedSource);
  const rootSources = config.rootEnabledSources ?? config.enabledSources;
  return [...rootSources].every((source) => config.downloadSources.has(source));
}

function searchTimeoutFor(namespace?: string): number {
  if (namespace === 'eljohnzc' || namespace === 'bitchordhires') {
    return config.remoteAddonTimeoutMs ?? config.sourceSearchTimeoutMs;
  }
  return config.sourceSearchTimeoutMs;
}

function healthTimeoutFor(source: IsolatedSource): number {
  if (source === 'eljohnzc' || source === 'bitchordhires') {
    return config.remoteAddonTimeoutMs ?? config.sourceHealthTimeoutMs;
  }
  return config.sourceHealthTimeoutMs;
}

function manifestQualityOptions(): Array<{ label: string; value: string }> {
  const labels: Record<string, string> = {
    HI_RES: 'Hi-Res', LOSSLESS: 'Lossless', HIGH: 'High', LOW: 'Low',
  };
  return QUALITY_TIERS
    .filter((tier) => config.enabledQualityTiers.has(tier))
    .map((tier) => ({ label: labels[tier], value: tier === 'HI_RES' ? 'hi_res' : tier.toLowerCase() }));
}

function healthQuality(): Quality {
  if (config.enabledQualityTiers.has('LOSSLESS')) return 'LOSSLESS';
  return QUALITY_TIERS.find((tier) => config.enabledQualityTiers.has(tier)) ?? 'LOSSLESS';
}

function assertQualityEnabled(quality: Quality): void {
  if (!config.enabledQualityTiers.has(quality)) {
    throw badRequest(`quality tier ${quality} is disabled by server configuration`);
  }
}

function downloadFilename(input: string | undefined, format: string | undefined): string {
  const fallbackFormat = String(format ?? 'flac').toLowerCase().replace(/[^a-z0-9.+-]/g, '').slice(0, 12) || 'flac';
  const raw = typeof input === 'string' ? input : 'download';
  let filename = raw.normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!filename) filename = 'download';
  const extension = `.${fallbackFormat}`;
  filename = filename.replace(/\.[a-z0-9]{1,12}$/i, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(filename)) filename = `_${filename}`;
  const maxBytes = 240;
  while (Buffer.byteLength(`${filename}${extension}`, 'utf8') > maxBytes && filename.length > 1) {
    filename = Array.from(filename).slice(0, -1).join('').trim();
  }
  return `${filename || 'download'}${extension}`;
}

async function resolveStream(
  provider: QobuzProvider,
  cache: TtlCache<Awaited<ReturnType<QobuzProvider['getStream']>>>,
  upstreamId: string,
  quality: Quality,
  atmos: string,
): Promise<Awaited<ReturnType<QobuzProvider['getStream']>>> {
  const key = `${upstreamId}\u0000${quality}\u0000${atmos}`;
  return cache.getOrLoad(
    key,
    () => withTimeout(provider.getStream(upstreamId, quality, atmos), config.serverRequestTimeoutMs),
    (stream) => streamCacheTtl(stream?.expiresAt),
  );
}

function streamCacheTtl(expiresAt?: number): number {
  if (!Number.isFinite(expiresAt) || !expiresAt || expiresAt <= 0) return config.cacheTtlMs;
  const expiresAtMs = expiresAt < 1_000_000_000_000 ? expiresAt * 1000 : expiresAt;
  return Math.min(config.cacheTtlMs, Math.max(1_000, expiresAtMs - Date.now() - 5_000));
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.message });
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const status =
    typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : typeof candidate.status === 'number'
        ? candidate.status
        : 500;
  return reply.code(status).send({ error: status >= 500 ? 'upstream service unavailable' : 'request failed' });
});

function parseQuality(value?: string): Quality {
  const normalized = normalizeAlias(value ?? 'LOSSLESS');
  // LastWave uses quality=atmos for its explicit immersive-stream attempt.
  // Atmos selection is carried separately by atmos=auto/on, so keep the
  // underlying audio tier lossless instead of adding a provider quality tier.
  if (normalized === 'ATMOS' || normalized === 'DOLBY_ATMOS') return 'LOSSLESS';
  if (normalized === 'LOSSLESS' || normalized === 'HIGH' || normalized === 'LOW') return normalized;
  if (normalized === 'HI_RES' || normalized === 'HIRES' || normalized === 'HI_RES_LOSSLESS' || normalized === 'HIRES_LOSSLESS') {
    return 'HI_RES';
  }
  throw badRequest('quality must be ATMOS, HI_RES, LOSSLESS, HIGH, or LOW');
}
function parseAtmos(value?: string): 'auto' | 'on' | 'off' {
  const normalized = normalizeAlias(value ?? 'auto').toLowerCase();
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') return normalized;
  if (normalized === 'none' || normalized === 'disabled' || normalized === 'disable' || normalized === 'false' || normalized === '0') {
    return 'off';
  }
  throw badRequest('atmos must be auto, on, or off');
}
function normalizeAlias(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError(504, 'upstream service timeout')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

if (process.env.VERCEL !== '1') {
  app
    .listen({ host: config.host, port: config.port })
    .then(() => {
      app.log.info({ host: config.host, port: config.port, provider: config.provider }, 'BitChord addon listening');
    })
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

export default app;
export { app, parseAtmos, parseQuality };
