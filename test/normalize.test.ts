import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrack, streamResponse, upstreamIdFromPublicId } from '../src/normalize.js';
import { TtlCache } from '../src/cache.js';

test('normalizes a track to an opaque stable id', () => {
  const track = normalizeTrack({ upstreamId: '123', title: 'Song', artist: 'Artist', artworkURL: 'https://cdn.example/a.jpg' });
  assert.match(track.id, /^qobuz_[A-Za-z0-9_-]+$/);
  assert.equal(track.title, 'Song');
  assert.equal(upstreamIdFromPublicId(track.id), '123');
});

test('exposes all quality tiers discovered from Hi-Res metadata', () => {
  const track = normalizeTrack({
    upstreamId: 'hires-123', title: 'Hi-Res Song', format: 'flac',
    audioQuality: 'HI_RES_LOSSLESS', sampleRate: 96_000, bitDepth: 24,
  });
  assert.deepEqual(track.availableQualities, ['HI_RES', 'LOSSLESS', 'HIGH']);
});

test('signed IDs reject tampering', () => {
  const id = normalizeTrack({ upstreamId: '123', title: 'Song' }).id;
  assert.equal(upstreamIdFromPublicId(`${id.slice(0, -1)}x`), undefined);
});

test('root IDs reject namespaced payloads', () => {
  const isolated = normalizeTrack({ upstreamId: '123', title: 'Song' }, undefined, 'instable').id;
  assert.equal(upstreamIdFromPublicId(isolated), undefined);
  assert.equal(upstreamIdFromPublicId(isolated, undefined, 'instable'), '123');
});

test('cache exposes stale values for outage fallback', async () => {
  const cache = new TtlCache<string>(1);
  cache.set('key', 'value');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cache.get('key'), undefined);
  assert.equal(cache.getStale('key'), 'value');
});

test('drops non-absolute artwork URLs', () => {
  assert.equal(normalizeTrack({ upstreamId: '123', title: 'Song', artworkURL: '/cover.jpg' }).artworkURL, undefined);
});

test('rejects encrypted or non-HTTPS streams', () => {
  assert.throws(() => streamResponse({ url: 'https://cdn.example/a.flac', encrypted: true }, 'LOSSLESS'));
  assert.throws(() => streamResponse({ url: 'http://cdn.example/a.flac' }, 'LOSSLESS'));
});

test('normalizes BitChord stream metadata without overstating invalid values', () => {
  assert.deepEqual(streamResponse({
    url: 'https://cdn.example/a.flac', format: 'FLAC', sampleRate: 96000, bitDepth: 24, bitrate: 0,
  }, 'LOSSLESS'), {
    url: 'https://cdn.example/a.flac', format: 'flac', quality: 'LOSSLESS', codec: 'flac', container: 'flac',
    manifest: 'none', encrypted: false, sampleRate: 96000, bitDepth: 24, bitrate: undefined,
  });
  assert.equal(streamResponse({ url: 'https://cdn.example/a', format: 'dash' }, 'LOSSLESS').manifest, 'dash');
});

test('normalizes audio/mpeg streams to the MP3 format contract', () => {
  assert.deepEqual(streamResponse({
    url: 'https://cdn.example/a.mp3', format: 'mpeg',
  }, 'HIGH'), {
    url: 'https://cdn.example/a.mp3', format: 'mp3', quality: 'HIGH', codec: 'mp3', container: 'mpeg',
    manifest: 'none', encrypted: false, sampleRate: undefined, bitDepth: undefined, bitrate: undefined,
  });
});

test('normalizes Dolby DASH transport and E-AC-3 JOC aliases', () => {
  assert.deepEqual(streamResponse({
    url: 'https://cdn.example/atmos-manifest', format: 'application/dash+xml', codec: 'eac3_joc',
    manifest: 'dash', audioMode: 'DOLBY_ATMOS', atmos: true,
  }, 'LOSSLESS'), {
    url: 'https://cdn.example/atmos-manifest', format: 'dash', quality: 'LOSSLESS', codec: 'eac3-joc',
    container: undefined, manifest: 'dash', encrypted: false, sampleRate: undefined, bitDepth: undefined,
    bitrate: undefined, audioMode: 'DOLBY_ATMOS', atmos: true,
  });
});

test('normalizes documented kHz and kbps shorthand to base units', () => {
  const normalized = streamResponse({
    url: 'https://cdn.example/a.flac', format: 'flac', sampleRate: 96, bitrate: 320,
  }, 'LOSSLESS');
  assert.equal(normalized.sampleRate, 96000);
  assert.equal(normalized.bitrate, 320000);
});
