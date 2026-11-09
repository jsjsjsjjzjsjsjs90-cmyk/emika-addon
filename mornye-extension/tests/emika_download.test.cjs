const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/emika');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

function runtime(stream) {
  let extension;
  const calls = { http: [], downloads: [], deletes: [], progress: [] };
  const context = vm.createContext({
    URL,
    registerExtension(value) { extension = value; },
    log: { info() {}, warn() {}, error() {} },
    http: { get(url) {
      calls.http.push(url);
      if (url.includes('/search?')) return { statusCode: 200, body: JSON.stringify({ tracks: [{ id: 'track-1', title: 'Song', artist: 'Artist', duration: 210, audioQuality: 'LOSSLESS' }] }) };
      return { statusCode: 200, body: JSON.stringify(stream) };
    } },
    file: {
      download(url, output, options) {
        calls.downloads.push({ url, output });
        if (options && options.onProgress) options.onProgress(50, 100);
        return { success: true, path: output };
      },
      delete(filePath) { calls.deletes.push(filePath); }
    },
    gobackend: { getAudioQuality() { return { audioCodec: 'flac', bitDepth: 16, sampleRate: 44100, duration: 210 }; } }
  });
  vm.runInContext(source, context);
  return { extension, calls };
}

test('manifest exposes a metadata and direct-audio download provider', () => {
  assert.deepEqual(manifest.type, ['metadata_provider', 'download_provider']);
  assert.ok(manifest.requiredRuntimeFeatures.includes('preparedContext@1'));
  assert.equal(manifest.permissions.file, true);
  assert.equal(manifest.capabilities.downloadFallbackTier, 'lossless');
});

test('search maps Emika tracks to Mornye metadata', () => {
  const { extension, calls } = runtime({});
  const tracks = extension.searchTracks('Song', 10);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, 'track-1');
  assert.equal(tracks[0].name, 'Song');
  assert.equal(tracks[0].duration_ms, 210000);
  assert.match(calls.http[0], /\/search\?q=Song&quality=lossless/);
});

test('lossless direct FLAC downloads and validates the resulting file', () => {
  const { extension, calls } = runtime({ url: 'https://cdn.example/song.flac', format: 'flac', manifest: 'none' });
  const result = extension.download('track-1', 'LOSSLESS', '/music/song.flac', p => calls.progress.push(p), { duration_ms: 210000 });
  assert.equal(result.success, true);
  assert.equal(result.file_path, '/music/song.flac');
  assert.equal(result.audio_codec, 'flac');
  assert.equal(result.sample_rate, 44100);
  assert.equal(calls.downloads.length, 1);
  assert.match(calls.downloads[0].url, /\/download\/track-1\?quality=lossless&atmos=auto/);
  assert.equal(calls.deletes.length, 0);
});

test('segmented manifests are rejected instead of being saved as audio', () => {
  const { extension, calls } = runtime({ url: 'https://cdn.example/manifest.mpd', format: 'dash', manifest: 'dash' });
  const result = extension.download('track-1', 'LOSSLESS', '/music/song.flac');
  assert.equal(result.success, false);
  assert.equal(result.error_type, 'unsupported_container');
  assert.equal(calls.downloads.length, 0);
});

test('lossless refuses a non-FLAC rendition', () => {
  const { extension, calls } = runtime({ url: 'https://cdn.example/song.m4a', format: 'aac', manifest: 'none' });
  const result = extension.download('track-1', 'LOSSLESS', '/music/song.flac');
  assert.equal(result.success, false);
  assert.equal(result.error_type, 'quality_mismatch');
  assert.equal(calls.downloads.length, 0);
});
