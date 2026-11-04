import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteAddonProvider } from '../src/providers/remote-addon.js';
import { InstableProvider } from '../src/providers/instable.js';
import { QobuzDlProvider } from '../src/providers/qobuzdl.js';
import { RacingProvider } from '../src/providers/racing.js';
import { normalizeHealthQuery } from '../src/query.js';
import type { Config } from '../src/config.js';
import type { QobuzProvider, Quality } from '../src/types.js';

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
    qobuzdlPlanLimitCooldownMs: 1000,
    sourceHealthTimeoutMs: 200,
    rateLimitWindowMs: 1000,
    rateLimitMaxRequests: 10,
    rateLimitMaxKeys: 100,
    maxQueryLength: 200,
    allowDownloads: false,
    checkValidLossless: false,
    requireBitChordUserAgent: false,
    allowSignedUiSession: false,
    uiSessionTtlSeconds: 3600,
    userAgent: 'BitChord/v1.9',
    proxyWebMedia: true,
    directStreamBitChord: true,
    directStreamLastWave: true,
    downloadSources: new Set(),
    enabledQualityTiers: new Set<Quality>(['HI_RES', 'LOSSLESS', 'HIGH', 'LOW']),
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
    assert.equal(requests[0]?.userAgent, 'BitChord/v1.9');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote addon accepts a manifest URL and uses a direct streamURL fallback', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      tracks: [{
        id: 'direct-1', title: 'Direct Track',
        streamURL: 'https://media.example.test/direct-1.flac',
        format: 'flac', audioQuality: 'LOSSLESS',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new RemoteAddonProvider(config(), 'https://remote.example.test/u/token/manifest.json');
    const tracks = await provider.search('direct', 'LOSSLESS', 'auto');
    const stream = await provider.getStream(tracks[0]!.upstreamId, 'LOSSLESS', 'auto');
    assert.equal(requests.length, 1);
    assert.equal(requests[0], 'https://remote.example.test/u/token/search?q=direct&quality=LOSSLESS&atmos=auto');
    assert.deepEqual(stream, {
      url: 'https://media.example.test/direct-1.flac',
      format: 'flac', quality: 'LOSSLESS', manifest: 'none', encrypted: false,
    });
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

test('remote addon does not reuse a direct stream URL for another quality', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ tracks: [{
        id: 'quality-1', title: 'Quality Track',
        streamURL: 'https://media.example.test/quality-1.flac',
        format: 'flac', audioQuality: 'LOSSLESS',
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ url: 'https://media.example.test/high.m4a', format: 'm4a', quality: 'HIGH' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new RemoteAddonProvider(config(), 'https://remote.example.test');
    const tracks = await provider.search('quality', 'LOSSLESS', 'auto');
    const stream = await provider.getStream(tracks[0]!.upstreamId, 'HIGH', 'auto');
    assert.equal(requests.length, 2);
    assert.equal(stream?.quality, 'HIGH');
    assert.equal(stream?.url, 'https://media.example.test/high.m4a');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote addon preserves the distinct HI_RES quality tier', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ url: 'https://media.example.test/hi-res.flac', format: 'flac', quality: 'HI_RES' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new RemoteAddonProvider(config(), 'https://remote.example.test');
    const stream = await provider.getStream('42', 'HI_RES', 'off');
    assert.equal(requests[0], 'https://remote.example.test/stream/42?quality=HI_RES&atmos=off');
    assert.equal(stream?.quality, 'HI_RES');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote addon does not reuse a direct stream URL for another Atmos mode', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (requests.length === 1) {
      return new Response(JSON.stringify({ tracks: [{
        id: 'atmos-1', title: 'Atmos Track', streamURL: 'https://media.example.test/stereo.flac',
        format: 'flac', audioQuality: 'HI_RES', atmos: false,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ url: 'https://media.example.test/atmos.flac', format: 'flac', quality: 'HI_RES', atmos: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new RemoteAddonProvider(config(), 'https://remote.example.test');
    const tracks = await provider.search('atmos', 'HI_RES', 'off');
    const stream = await provider.getStream(tracks[0]!.upstreamId, 'HI_RES', 'on');
    assert.equal(requests.length, 2);
    assert.equal(requests[1], 'https://remote.example.test/stream/atmos-1?quality=HI_RES&atmos=on');
    assert.equal(stream?.atmos, true);
    assert.equal(stream?.url, 'https://media.example.test/atmos.flac');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable receives atmos=on and HI_RES quality id 27 on search and stream', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/search')) {
      return new Response(JSON.stringify({ tracks: [{
        id: '42', title: 'Atmos Track', maximum_sampling_rate: 192,
        maximum_bit_depth: 24, hires: true,
      }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      url: 'https://media.example.test/atmos.flac',
      format: 'flac',
      audioMode: 'DOLBY_ATMOS',
      audioModes: ['DOLBY_ATMOS', 'STEREO'],
      atmos: true,
      streamQuality: 'HI_RES_LOSSLESS',
      audioQuality: 'HI_RES_LOSSLESS',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({
      instableBaseUrl: 'https://instable.example.test',
      instableQualityHiRes: '27',
    }));
    const tracks = await provider.search('atmos track', 'HI_RES', 'on');
    assert.equal(tracks[0]?.sampleRate, 192000);
    assert.equal(tracks[0]?.bitDepth, 24);
    assert.equal(tracks[0]?.audioQuality, 'HI_RES_LOSSLESS');
    const stream = await provider.getStream('42', 'HI_RES', 'on');
    assert.equal(requests[0], 'https://instable.example.test/api/search?q=atmos+track&limit=10&atmos=on');
    assert.equal(requests[1], 'https://instable.example.test/api/player/stream/42?quality=27&atmos=on');
    assert.equal(stream?.audioMode, 'DOLBY_ATMOS');
    assert.deepEqual(stream?.audioModes, ['DOLBY_ATMOS', 'STEREO']);
    assert.equal(stream?.atmos, true);
    assert.equal(stream?.sampleRate, 192000);
    assert.equal(stream?.bitDepth, 24);
    assert.equal(stream?.streamQuality, 'HI_RES_LOSSLESS');
    assert.equal(stream?.audioQuality, 'HI_RES_LOSSLESS');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable search does not label HIGH results as Hi-Res', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ tracks: [{
    id: 'high-42', title: 'High Track', maximum_sampling_rate: 192,
    maximum_bit_depth: 24, hires: true,
  }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const provider = new InstableProvider(config({ instableBaseUrl: 'https://instable.example.test' }));
    const tracks = await provider.search('high track', 'HIGH', 'off');
    assert.equal(tracks[0]?.format, 'mp3');
    assert.equal(tracks[0]?.audioQuality, 'HIGH');
    assert.equal(tracks[0]?.sampleRate, undefined);
    assert.equal(tracks[0]?.bitDepth, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable maps Qobuz LOSSLESS to quality id 6 instead of the Hi-Res id', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify({
      url: 'https://media.example.test/lossless.flac',
      format: 'flac',
      sampleRate: 44100,
      bitDepth: 16,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({ instableBaseUrl: 'https://instable.example.test' }));
    const stream = await provider.getStream('42', 'LOSSLESS', 'auto');
    assert.equal(requests[0], 'https://instable.example.test/api/player/stream/42?quality=6&atmos=auto');
    assert.equal(stream?.sampleRate, 44100);
    assert.equal(stream?.bitDepth, 16);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qobuz-DL keeps LOSSLESS on quality id 6 and HI_RES on 27', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: { url: 'https://media.example.test/track.flac' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new QobuzDlProvider(config({ apiBaseUrl: 'https://qobuz.example.test' }));
    await provider.getStream('42', 'LOSSLESS', 'off');
    await provider.getStream('42', 'HI_RES', 'off');
    assert.equal(requests[0], 'https://qobuz.example.test/api/download-music?track_id=42&quality=6');
    assert.equal(requests[1], 'https://qobuz.example.test/api/download-music?track_id=42&quality=27');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qobuz-DL preserves Hi-Res metadata from search through stream resolution', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/get-music')) {
      return new Response(JSON.stringify({
        data: { tracks: { items: [{
          id: 156469673,
          title: 'Vegas',
          performer: { name: 'Doja Cat' },
          maximum_sampling_rate: 96,
          maximum_bit_depth: 24,
          hires: true,
        }] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { url: 'https://media.example.test/vegas.flac' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new QobuzDlProvider(config({ apiBaseUrl: 'https://qobuz.example.test' }));
    const tracks = await provider.search('vegas doja cat', 'HI_RES', 'auto');
    assert.equal(tracks[0]?.sampleRate, 96_000);
    assert.equal(tracks[0]?.bitDepth, 24);
    assert.equal(tracks[0]?.audioQuality, 'HI_RES_LOSSLESS');
    const stream = await provider.getStream('156469673', 'HI_RES', 'auto');
    assert.equal(stream?.format, 'flac');
    assert.equal(stream?.sampleRate, 96_000);
    assert.equal(stream?.bitDepth, 24);
    assert.equal(requests[0], 'https://qobuz.example.test/api/get-music?q=vegas+doja+cat&offset=0');
    assert.equal(requests[1], 'https://qobuz.example.test/api/download-music?track_id=156469673&quality=27');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qobuz-DL projects Lossless metadata to the actual CD rendition', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/api/get-music')) {
      return new Response(JSON.stringify({ data: { tracks: { items: [{
        id: 160900560, title: 'Vegas', performer: { name: 'Doja Cat' },
        maximum_sampling_rate: 96, maximum_bit_depth: 24, hires: true,
      }] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { url: 'https://media.example.test/vegas-cd.flac' } }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new QobuzDlProvider(config({ apiBaseUrl: 'https://qobuz.example.test' }));
    const tracks = await provider.search('vegas', 'LOSSLESS', 'auto');
    assert.equal(tracks[0]?.sampleRate, 44_100);
    assert.equal(tracks[0]?.bitDepth, 16);
    assert.equal(tracks[0]?.audioQuality, 'LOSSLESS');
    const stream = await provider.getStream('160900560', 'LOSSLESS', 'auto');
    assert.equal(stream?.sampleRate, 44_100);
    assert.equal(stream?.bitDepth, 16);
    assert.equal(stream?.audioQuality, 'LOSSLESS');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable upgrades BitChord LOSSLESS to quality id 27 for a searched Hi-Res track', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/search')) {
      return new Response(JSON.stringify({ tracks: [{
        id: '42', title: 'Hi-Res Track', maximum_sampling_rate: 96,
        maximum_bit_depth: 24, hires: true,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      url: 'https://media.example.test/hi-res.flac',
      mimeType: 'audio/flac',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({
      instableBaseUrl: 'https://instable.example.test',
      instableQualityHiRes: '27',
      instableQualityLossless: '6',
    }));
    const tracks = await provider.search('hi-res track', 'LOSSLESS', 'off');
    const stream = await provider.getStream(tracks[0]!.upstreamId, 'LOSSLESS', 'off');
    assert.equal(requests[1], 'https://instable.example.test/api/player/stream/42?quality=27&atmos=off');
    assert.equal(stream?.quality, 'LOSSLESS');
    assert.equal(stream?.sampleRate, 96000);
    assert.equal(stream?.bitDepth, 24);
    assert.equal(stream?.audioQuality, 'HI_RES_LOSSLESS');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable does not upgrade LOSSLESS when HI_RES is disabled', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/search')) {
      return new Response(JSON.stringify({ tracks: [{
        id: '42', title: 'Hi-Res Track', maximum_sampling_rate: 44.1,
        maximum_bit_depth: 24, hires: true,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      url: 'https://media.example.test/lossless.flac',
      mimeType: 'audio/flac', sampleRate: 44100, bitDepth: 16,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({
      instableBaseUrl: 'https://instable.example.test',
      enabledQualityTiers: new Set<Quality>(['LOSSLESS', 'HIGH', 'LOW']),
    }));
    const tracks = await provider.search('hi-res track', 'LOSSLESS', 'off');
    assert.equal(tracks[0]?.audioQuality, 'LOSSLESS');
    assert.equal(tracks[0]?.sampleRate, undefined);
    assert.equal(tracks[0]?.bitDepth, undefined);
    const stream = await provider.getStream(tracks[0]!.upstreamId, 'LOSSLESS', 'off');
    assert.equal(requests[1], 'https://instable.example.test/api/player/stream/42?quality=6&atmos=off');
    assert.equal(stream?.sampleRate, 44100);
    assert.equal(stream?.bitDepth, 16);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable maps Qobuz HIGH to quality id 5 (MP3 320)', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      url: 'https://media.example.test/high.mp3',
      format: 'mp3',
      bitrate: 320000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({ instableBaseUrl: 'https://instable.example.test' }));
    const stream = await provider.getStream('42', 'HIGH', 'off');
    assert.equal(requests[0], 'https://instable.example.test/api/player/stream/42?quality=5&atmos=off');
    assert.equal(stream?.format, 'mp3');
    assert.equal(stream?.bitrate, 320000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable does not reuse Hi-Res search metadata for a Lossless stream', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/api/search')) {
      return new Response(JSON.stringify({ tracks: [{
        id: 'metadata-isolation', title: 'Track', maximum_sampling_rate: 192, maximum_bit_depth: 24, hires: true,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      url: 'https://media.example.test/lossless.flac', format: 'flac',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({ instableBaseUrl: 'https://instable.example.test' }));
    await provider.search('track', 'HI_RES', 'off');
    const stream = await provider.getStream('metadata-isolation', 'LOSSLESS', 'off');
    assert.equal(stream?.sampleRate, undefined);
    assert.equal(stream?.bitDepth, undefined);
    assert.equal(stream?.audioQuality, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Instable leaves LOW unsupported instead of duplicating the HIGH tier', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new InstableProvider(config({ instableBaseUrl: 'https://instable.example.test' }));
    assert.equal(await provider.getStream('42', 'LOW', 'off'), null);
    assert.equal(calls, 0);
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

test('racing provider ignores unusable tracks and falls back to another source', async () => {
  const provider = new RacingProvider([
    { name: 'bad', provider: { async search() { return [{ upstreamId: '', title: '' }]; }, async getStream() { return null; } } },
    { name: 'good', provider: { async search() { return [{ upstreamId: 'ok', title: 'Usable' }]; }, async getStream() { return null; } } },
  ], 100);
  assert.deepEqual(await provider.search('x', 'LOSSLESS', 'auto'), [
    { upstreamId: 'good:ok', title: 'Usable' },
  ]);
});

test('racing provider cools down Qobuz-DL after a plan-limit error', async () => {
  let qobuzCalls = 0;
  const provider = new RacingProvider([
    { name: 'qobuzdl', provider: {
      async search() { qobuzCalls += 1; throw new Error('Qobuz-DL plan limit reached; source temporarily unavailable'); },
      async getStream() { return null; },
    } },
    { name: 'instable', provider: {
      async search() { return [{ upstreamId: 'fallback', title: 'Fallback' }]; },
      async getStream() { return null; },
    } },
  ], 100, 10_000);
  assert.deepEqual(await provider.search('x', 'LOSSLESS', 'auto'), [
    { upstreamId: 'instable:fallback', title: 'Fallback' },
  ]);
  assert.deepEqual(await provider.search('x', 'LOSSLESS', 'auto'), [
    { upstreamId: 'instable:fallback', title: 'Fallback' },
  ]);
  assert.equal(qobuzCalls, 1);
});

test('health query is bounded before fan-out to upstream sources', () => {
  assert.equal(normalizeHealthQuery(undefined, 20), 'vegas doja cat');
  assert.equal(normalizeHealthQuery('  jazz  ', 10), 'jazz');
  assert.throws(() => normalizeHealthQuery('12345678901', 10), /at most 10/);
});
