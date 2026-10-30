import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteAddonProvider } from '../src/providers/remote-addon.js';
import { RacingProvider } from '../src/providers/racing.js';
import { normalizeHealthQuery } from '../src/query.js';
import type { Config } from '../src/config.js';
import type { QobuzProvider } from '../src/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 3000,
    requestTimeoutMs: 1000,
    serverRequestTimeoutMs: 1500,
    upstreamRetries: 1,
    cacheTtlMs: 1000,
    idSecret: 'test-secret',
    provider: 'multi',
    enabledSources: new Set(),
    sourceSearchTimeoutMs: 100,
    rateLimitWindowMs: 1000,
    rateLimitMaxRequests: 10,
    rateLimitMaxKeys: 100,
    maxQueryLength: 200,
    deezerBaseUrl: 'https://fallback.example.test',
    ...overrides,
  };
}

test('remote addon preserves a base path and sends the BitChord client identity', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; userAgent: string | undefined }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      userAgent: new Headers(init?.headers).get('user-agent') ?? undefined,
    });
    return new Response(JSON.stringify({ tracks: [{ id: '42', title: 'Track', artist: 'Artist' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new RemoteAddonProvider(config(), 'https://remote.example.test/u/token');
    const tracks = await provider.search('track', 'LOSSLESS', 'auto');
    assert.equal(tracks[0]?.upstreamId, '42');
    assert.equal(requests[0]?.url, 'https://remote.example.test/u/token/search?q=track&quality=LOSSLESS&atmos=auto');
    assert.equal(requests[0]?.userAgent, 'BitChord/1.8.1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote addon rejects non-HTTPS stream responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ url: 'http://insecure.example.test/audio' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const provider = new RemoteAddonProvider(config(), 'https://remote.example.test');
    assert.equal(await provider.getStream('42', 'LOSSLESS', 'auto'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('racing provider keeps the winning source namespace for stream resolution', async () => {
  const sourceA: QobuzProvider = {
    async search() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ upstreamId: 'slow', title: 'Slow' }];
    },
    async getStream() { return null; },
  };
  const sourceB: QobuzProvider = {
    async search() { return [{ upstreamId: 'fast', title: 'Fast' }]; },
    async getStream(trackId) {
      return trackId === 'fast' ? { url: 'https://cdn.example.test/fast.flac', manifest: 'none' } : null;
    },
  };

  const provider = new RacingProvider(
    [{ name: 'slow', provider: sourceA }, { name: 'fast', provider: sourceB }],
    100,
  );
  const tracks = await provider.search('x', 'LOSSLESS', 'auto');
  assert.deepEqual(tracks, [{ upstreamId: 'fast:fast', title: 'Fast' }]);
  assert.deepEqual(await provider.getStream('fast:fast', 'LOSSLESS', 'auto'), {
    url: 'https://cdn.example.test/fast.flac',
    manifest: 'none',
  });
});

test('health query is bounded before fan-out to upstream sources', () => {
  assert.equal(normalizeHealthQuery(undefined, 10), 'love');
  assert.equal(normalizeHealthQuery('  jazz  ', 10), 'jazz');
  assert.throws(() => normalizeHealthQuery('12345678901', 10), /at most 10/);
});
