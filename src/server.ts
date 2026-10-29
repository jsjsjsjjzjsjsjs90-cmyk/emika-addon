import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { homePage } from './home.js';
import { TtlCache } from './cache.js';
import { AppError, badRequest, notFound } from './errors.js';
import { normalizeTrack, streamResponse, upstreamIdFromPublicId } from './normalize.js';
import { createProvider, createSourceProvider, type IsolatedSource } from './providers/index.js';
import { SlidingWindowRateLimiter, clientKey } from './rate-limit.js';
import type { QobuzProvider, Quality, PublicTrack } from './types.js';

const config = loadConfig();
const app = Fastify({
  logger: { redact: ['req.headers.authorization', 'req.headers.cookie', '*.url'] },
  requestTimeout: config.serverRequestTimeoutMs,
});
const limiter = new SlidingWindowRateLimiter(config.rateLimitMaxRequests, config.rateLimitWindowMs, config.rateLimitMaxKeys);
app.addHook('onRequest', async (request, reply) => {
  const pathname = request.url.split('?', 1)[0];
  if (!pathname.includes('/search') && !pathname.includes('/stream/') && pathname !== '/health/sources') return;
  const result = limiter.check(clientKey(request.ip));
  reply.header('X-RateLimit-Limit', result.limit);
  reply.header('X-RateLimit-Remaining', result.remaining);
  reply.header('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));
  if (!result.allowed) {
    reply.header('Retry-After', Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
    return reply.code(429).send({ error: 'rate limit exceeded' });
  }
});

const manifests = {
  root:       { id: 'com.bitchord.qobuz',            name: 'Emika addon',              version: '1.0.0' },
  qobuzdl:    { id: 'com.bitchord.qobuz.qobuzdl',    name: 'Qobuz-DL',                 version: '1.0.0' },
  lastbabe:   { id: 'com.bitchord.qobuz.lastbabe',   name: 'LastBabe',                 version: '1.0.0' },
  monochrome: { id: 'com.bitchord.qobuz.monochrome', name: 'Monochrome Lossless',      version: '1.0.0' },
  deezer:     { id: 'com.bitchord.qobuz.deezer',     name: 'Deezer Fallback',          version: '1.0.0' },
  eljohnzc:   { id: 'com.bitchord.qobuz.eljohnzc',   name: 'Eljohnzc Lossless',        version: '1.0.0' },
  instable:   { id: 'com.bitchord.qobuz.instable',   name: 'Instable Lossless',        version: '1.0.0' },
} as const;

app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(homePage));
app.get('/health', async () => ({ ok: true }));

const STUB_SOURCES: ReadonlySet<IsolatedSource> = new Set<IsolatedSource>(['eljohnzc']);

app.get<{ Querystring: { q?: string } }>('/health/sources', async (request) => {
  const testQuery = request.query.q || 'love';
  const sourceNames: IsolatedSource[] = [
    'qobuzdl', 'lastbabe', 'monochrome', 'deezer', 'eljohnzc', 'instable',
  ];

  const results = await Promise.all(
    sourceNames.map(async (sourceName) => {
      if (STUB_SOURCES.has(sourceName)) {
        return { source: sourceName, status: 'not_implemented' as const, latencyMs: 0, resultCount: 0 };
      }
      if (!config.enabledSources.has(sourceName as Exclude<IsolatedSource, 'eljohnzc'>)) {
        return { source: sourceName, status: 'disabled_by_config' as const, latencyMs: 0, resultCount: 0 };
      }
      const provider = createSourceProvider(config, sourceName);
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('operation timed out')), config.sourceSearchTimeoutMs);
        });
        const tracks = await Promise.race([
          withTimeout(provider.search(testQuery, 'LOSSLESS', 'auto'), config.sourceSearchTimeoutMs),
          timeoutPromise,
        ]);
        return {
          source: sourceName,
          status: tracks.length > 0 ? ('healthy' as const) : ('no_results' as const),
          latencyMs: Date.now() - started,
          resultCount: tracks.length,
        };
      } catch (error) {
        return {
          source: sourceName,
          status: 'unhealthy' as const,
          latencyMs: Date.now() - started,
          error: error instanceof Error && error.message === 'operation timed out' ? 'timeout' : 'upstream unavailable',
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );

  const enabled = results.filter(
    (r) => r.status !== 'not_implemented' && r.status !== 'disabled_by_config',
  );
  const healthy = enabled.filter((r) => r.status === 'healthy').length;

  let overallStatus = 'outage';
  if (enabled.length === 0) overallStatus = 'no_sources_enabled';
  else if (healthy === enabled.length) overallStatus = 'all_systems_operational';
  else if (healthy >= Math.ceil(enabled.length / 2)) overallStatus = 'operational_with_minor_outages';
  else if (healthy >= 1) overallStatus = 'degraded_but_functional';

  return {
    timestamp: new Date().toISOString(),
    testQuery,
    overallStatus,
    enabledSources: enabled.length,
    healthySources: healthy,
    totalSources: results.length,
    providers: results,
  };
});

registerAddon('/',    createProvider(config),                     manifests.root);
registerAddon('/a',   createSourceProvider(config, 'qobuzdl'),    manifests.qobuzdl, 'qobuzdl');
registerAddon('/b',   createSourceProvider(config, 'lastbabe'),   manifests.lastbabe, 'lastbabe');
registerAddon('/c',   createSourceProvider(config, 'monochrome'), manifests.monochrome, 'monochrome');
registerAddon('/d',   createSourceProvider(config, 'deezer'),     manifests.deezer, 'deezer');
registerAddon('/e',   createSourceProvider(config, 'eljohnzc'),   manifests.eljohnzc, 'eljohnzc');
registerAddon('/f',   createSourceProvider(config, 'instable'),   manifests.instable, 'instable');

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
  const route = (path: string): string => joinRoute(prefix, path);

  app.get(route('/manifest.json'), async (_request, reply) =>
    reply
      .header('Cache-Control', 'public, max-age=3600, s-maxage=86400')
      .send({
        ...manifest,
        resources: ['search', 'stream'],
        allowDownloads: 0,
        checkValidLossless: 0,
        settings: [
          {
            key: 'quality',
            type: 'select',
            default: 'lossless',
            options: [
              { label: 'Lossless', value: 'lossless' },
              { label: 'High', value: 'high' },
              { label: 'Low', value: 'low' },
            ],
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
      const atmos = parseAtmos(request.query.atmos);
      const key = `${query}\u0000${quality}\u0000${atmos}`;

      try {
        const tracks = await searchCache.getOrLoad(key, async () =>
          (await withTimeout(provider.search(query, quality, atmos), config.serverRequestTimeoutMs)).flatMap((track) => {
            try {
              return [normalizeTrack(track, config.idSecret, namespace)];
            } catch {
              return [];
            }
          }),
        );
        return reply
          .header('Cache-Control', 'public, max-age=30, s-maxage=300, stale-while-revalidate=600')
          .send({ tracks });
      } catch (error) {
        const stale = searchCache.getStale(key);
        if (stale) {
          return reply
            .header('Cache-Control', 'public, max-age=10, s-maxage=30, stale-while-revalidate=120')
            .send({ tracks: stale, stale: true });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { quality?: string; atmos?: string } }>(
    route('/stream/:id'),
    async (request, reply) => {
      const quality = parseQuality(request.query.quality);
      const atmos = parseAtmos(request.query.atmos);
      const id = request.params.id;
      if (!/^qobuz_[A-Za-z0-9_-]{10,120}$/.test(id)) throw notFound('track not found');
      const upstreamId = upstreamIdFromPublicId(id, config.idSecret, namespace);
      if (!upstreamId) throw notFound('track not available');
      const stream = await withTimeout(provider.getStream(upstreamId, quality, atmos), config.serverRequestTimeoutMs);
      if (!stream) throw notFound('track not available');
      try {
        return reply.send(streamResponse(stream, quality));
      } catch {
        throw notFound('track has no playable rendition');
      }
    },
  );
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
  const normalized = (value ?? 'LOSSLESS').toUpperCase();
  if (normalized === 'LOSSLESS' || normalized === 'HIGH' || normalized === 'LOW') return normalized;
  throw badRequest('quality must be LOSSLESS, HIGH, or LOW');
}
function parseAtmos(value?: string): 'auto' | 'on' | 'off' {
  const normalized = (value ?? 'auto').toLowerCase();
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') return normalized;
  throw badRequest('atmos must be auto, on, or off');
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
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
export { app, parseQuality };
