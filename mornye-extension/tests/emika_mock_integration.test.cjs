const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/emika');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function makeRuntime(options = {}) {
  let registered;
  const calls = { http: [], downloads: [], deletes: [], progress: [] };
  const tracks = options.tracks || [{ id: 'track-1', title: 'Signal', artist: 'Artist', album: 'Album', duration: 210, isrc: 'USAAA2400001', audioQuality: 'LOSSLESS' }];
  const stream = options.stream || { url: 'https://media.example/song.flac', format: 'flac', manifest: 'none', bitDepth: 16, sampleRate: 44100 };
  const quality = options.measured || { audioCodec: 'flac', bitDepth: 16, sampleRate: 44100, duration: 210 };
  const context = vm.createContext({
    URL,
    registerExtension(value) { registered = value; },
    log: { info() {}, warn() {}, error() {} },
    http: { get(url) {
      calls.http.push(url);
      if (options.httpError) return { statusCode: options.httpStatus || 503, body: options.httpBody || '' };
      if (url.includes('/search?')) return { statusCode: 200, body: options.invalidJSON ? '{bad' : JSON.stringify({ tracks }) };
      return { statusCode: 200, body: JSON.stringify(stream) };
    } },
    file: {
      download(url, output, transferOptions) {
        calls.downloads.push({ url, output });
        if (options.downloadError) return { success: false, error: 'network failed', error_type: 'network_error' };
        if (transferOptions && transferOptions.onProgress) {
          transferOptions.onProgress(25, 100);
          transferOptions.onProgress(100, 100);
        }
        return { success: true, path: output };
      },
      delete(filePath) { calls.deletes.push(filePath); }
    },
    gobackend: { getAudioQuality() { return options.noProbe ? null : quality; } }
  });
  vm.runInContext(source, context);
  return { extension: registered, calls };
}

test('manifest and registration contract are valid', () => {
  const { extension } = makeRuntime();
  assert.equal(typeof extension.initialize, 'function');
  assert.equal(typeof extension.cleanup, 'function');
  assert.equal(typeof extension.searchTracks, 'function');
  assert.equal(typeof extension.customSearch, 'function');
  assert.equal(typeof extension.checkAvailability, 'function');
  assert.equal(typeof extension.download, 'function');
  assert.equal(typeof extension.getDownloadUrl, 'function');
  assert.deepEqual(manifest.type, ['metadata_provider', 'download_provider']);
  assert.equal(extension.getDownloadUrl('track-1'), null);
});

test('initialize normalizes endpoint and cleanup is safe', () => {
  const { extension, calls } = makeRuntime();
  assert.equal(extension.initialize({ endpoint: 'https://mirror.example/manifest.json', quality: 'lossless' }), true);
  assert.equal(extension.cleanup(), true);
  extension.searchTracks('Signal', 1);
  assert.match(calls.http[0], /^https:\/\/mirror\.example\/search\?/);
});

test('searchTracks and customSearch return normalized Mornye tracks', () => {
  const { extension } = makeRuntime();
  const search = extension.searchTracks('Signal', 10);
  const custom = extension.customSearch('Signal', { limit: 5 });
  assert.equal(search[0].id, 'track-1');
  assert.equal(search[0].duration_ms, 210000);
  assert.equal(search[0].provider_id, 'emika');
  assert.equal(custom.length, 1);
});

test('checkAvailability uses ISRC/name/artist/duration matching', () => {
  const { extension } = makeRuntime();
  const result = extension.checkAvailability('USAAA2400001', 'Signal', 'Artist', { duration_ms: 210000 });
  assert.equal(result.available, true);
  assert.equal(result.track_id, 'track-1');
  assert.equal(result.prepared_context.track.name, 'Signal');
  const miss = extension.checkAvailability('USBBB2400002', 'Different', 'Other', { duration_ms: 10000 });
  assert.equal(miss.available, false);
});

test('direct lossless download completes and reports measured audio metadata', () => {
  const { extension, calls } = makeRuntime();
  const result = extension.download('track-1', 'LOSSLESS', '/music/signal.flac', p => calls.progress.push(p), { duration_ms: 210000 });
  assert.deepEqual({ success: result.success, codec: result.audio_codec, bits: result.bit_depth, rate: result.sample_rate }, { success: true, codec: 'flac', bits: 16, rate: 44100 });
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.progress.length, 4);
  assert.ok(Math.abs(calls.progress[0] - 0.05) < 1e-9);
  assert.ok(Math.abs(calls.progress[1] - 0.275) < 1e-9);
  assert.ok(Math.abs(calls.progress[2] - 0.95) < 1e-9);
  assert.equal(calls.progress[3], 1);
});

test('lossy download does not incorrectly require FLAC', () => {
  const { extension } = makeRuntime({ stream: { url: 'https://media.example/song.m4a', format: 'aac', manifest: 'none' }, measured: { audioCodec: 'aac', sampleRate: 44100, duration: 210 } });
  const result = extension.download('track-1', 'HIGH', '/music/signal.m4a', null, { duration_ms: 210000 });
  assert.equal(result.success, true);
  assert.equal(result.audio_codec, 'aac');
});

test('DASH/MPD or any segmented response is rejected before file transfer', () => {
  const { extension, calls } = makeRuntime({ stream: { url: 'https://media.example/song.mpd', format: 'dash', manifest: 'dash' } });
  const result = extension.download('track-1', 'LOSSLESS', '/music/signal.flac');
  assert.equal(result.success, false);
  assert.equal(result.error_type, 'unsupported_container');
  assert.equal(calls.downloads.length, 0);
});

test('false lossless is rejected by advertised format and measured codec', () => {
  const advertised = makeRuntime({ stream: { url: 'https://media.example/song.m4a', format: 'aac', manifest: 'none' } });
  assert.equal(advertised.extension.download('track-1', 'LOSSLESS', '/music/song.flac').error_type, 'quality_mismatch');
  const measured = makeRuntime({ stream: { url: 'https://media.example/song.bin', format: 'flac', manifest: 'none' }, measured: { audioCodec: 'aac', duration: 210 } });
  const result = measured.extension.download('track-1', 'LOSSLESS', '/music/song.flac');
  assert.equal(result.success, false);
  assert.equal(result.error_type, 'quality_mismatch');
  assert.equal(measured.calls.deletes.length, 1);
});

test('duration mismatch deletes the downloaded file', () => {
  const { extension, calls } = makeRuntime({ measured: { audioCodec: 'flac', sampleRate: 44100, duration: 100 } });
  const result = extension.download('track-1', 'LOSSLESS', '/music/song.flac', null, { duration_ms: 210000 });
  assert.equal(result.success, false);
  assert.equal(result.error_type, 'duration_mismatch');
  assert.deepEqual(calls.deletes, ['/music/song.flac']);
});

test('HTTP, JSON and file-transfer failures become safe structured errors', () => {
  assert.throws(() => makeRuntime({ httpError: true }).extension.searchTracks('x'), /Emika request failed/);
  assert.throws(() => makeRuntime({ invalidJSON: true }).extension.searchTracks('x'), /invalid JSON/);
  const failed = makeRuntime({ downloadError: true }).extension.download('track-1', 'LOSSLESS', '/music/song.flac');
  assert.equal(failed.success, false);
  assert.equal(failed.error_type, 'network_error');
});
