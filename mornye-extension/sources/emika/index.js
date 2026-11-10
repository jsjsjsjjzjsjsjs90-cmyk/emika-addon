"use strict";

var CONFIG = {
  endpoint: "https://api.zarz.moe/v1/dl/tid2",
  quality: "LOSSLESS"
};

function normalizeEndpoint(value) {
  var text = String(value || "").trim();
  if (!/^https:\/\/[^\/?#]+/i.test(text)) return "";
  return text.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
}

function initialize(settings) {
  settings = settings || {};
  CONFIG.endpoint = normalizeEndpoint(settings.endpoint) || CONFIG.endpoint;
  CONFIG.quality = String(settings.quality || CONFIG.quality).trim().toUpperCase();
  return true;
}

function cleanup() { return true; }

function responseError(response) {
  if (!response) return "no response";
  if (response.error) return String(response.error);
  return response.statusCode ? "HTTP " + response.statusCode : "missing HTTP status";
}

function getJSON(url) {
  var response = http.get(url, { "Accept": "application/json", "User-Agent": "Mornye-Emika/1.0" });
  if (!response || response.error || response.statusCode !== 200) {
    throw new Error("Emika request failed: " + responseError(response));
  }
  try { return JSON.parse(response.body || "{}"); }
  catch (_) { throw new Error("Emika returned invalid JSON"); }
}

function qualityValue(value) {
  var normalized = String(value || CONFIG.quality || "LOSSLESS").trim().toLowerCase();
  return normalized === "hi_res" || normalized === "hires" ? "hi_res" : normalized;
}

function mapTrack(item) {
  if (!item || !item.id || !item.title) return null;
  var duration = Number(item.duration || 0);
  return {
    id: String(item.id),
    name: String(item.title),
    artists: String(item.artist || ""),
    album_name: String(item.album || ""),
    duration_ms: duration > 0 && duration < 100000 ? Math.round(duration * 1000) : Math.round(duration),
    cover_url: String(item.artworkURL || item.coverURL || ""),
    isrc: String(item.isrc || ""),
    provider_id: "emika",
    audio_quality: String(item.audioQuality || item.quality || ""),
    audio_modes: String(item.audioMode || "")
  };
}

function searchTracks(query, limit) {
  var text = String(query || "").trim();
  if (!text) return [];
  var max = Math.max(1, Math.min(Number(limit || 20), 50));
  var url = CONFIG.endpoint + "/search?q=" + encodeURIComponent(text) +
    "&quality=" + encodeURIComponent(qualityValue(CONFIG.quality));
  var payload = getJSON(url);
  var rows = Array.isArray(payload.tracks) ? payload.tracks : [];
  return rows.slice(0, max).map(mapTrack).filter(Boolean);
}

function customSearch(query, options) {
  return searchTracks(query, options && options.limit || 20);
}

function findBestMatch(isrc, name, artist, durationMs) {
  var query = (String(name || "") + " " + String(artist || "")).trim();
  var candidates = searchTracks(query, 20);
  var wantedIsrc = String(isrc || "").toUpperCase();
  var best = null;
  var bestScore = -1;
  candidates.forEach(function (candidate) {
    var score = 0;
    if (wantedIsrc && String(candidate.isrc || "").toUpperCase() === wantedIsrc) score += 100;
    if (String(candidate.name || "").toLowerCase() === String(name || "").toLowerCase()) score += 45;
    if (String(candidate.artists || "").toLowerCase().indexOf(String(artist || "").toLowerCase()) >= 0) score += 30;
    var diff = Math.abs(Number(candidate.duration_ms || 0) - Number(durationMs || 0));
    if (durationMs > 0 && diff <= 10000) score += 25;
    if (score > bestScore) { best = candidate; bestScore = score; }
  });
  return bestScore >= 45 ? best : null;
}

function checkAvailability(isrc, trackName, artistName, options) {
  try {
    var duration = Number(options && (options.duration_ms || options.durationMs) || 0);
    var match = findBestMatch(isrc, trackName, artistName, duration);
    return match ? { available: true, track_id: match.id, prepared_context: { track: match } } :
      { available: false, reason: "No confident Emika match found" };
  } catch (error) {
    return { available: false, reason: error && error.message ? error.message : String(error) };
  }
}

function deleteQuietly(path) {
  if (path && typeof file.delete === "function") { try { file.delete(path); } catch (_) {} }
}

function durationSeconds(info) {
  if (!info) return 0;
  if (Number(info.duration) > 0) return Number(info.duration);
  if (Number(info.sampleRate) > 0 && Number(info.totalSamples) > 0) return Number(info.totalSamples) / Number(info.sampleRate);
  return 0;
}

function download(trackID, quality, outputPath, onProgress, options) {
  try {
    var requested = qualityValue(quality);
    var streamURL = CONFIG.endpoint + "/stream/" + encodeURIComponent(String(trackID)) +
      "?quality=" + encodeURIComponent(requested) + "&atmos=auto";
    var stream = getJSON(streamURL);
    var manifest = String(stream.manifest || "none").toLowerCase();
    if (manifest !== "none") return { success: false, error_message: "Emika returned a segmented manifest; direct-audio download is required", error_type: "unsupported_container" };
    var format = String(stream.format || stream.container || stream.codec || "").toLowerCase();
    if (requested === "lossless" && format && format.indexOf("flac") < 0) {
      return { success: false, error_message: "Emika did not return a FLAC rendition for lossless", error_type: "quality_mismatch" };
    }
    if (!stream.url) return { success: false, error_message: "Emika returned no audio URL", error_type: "download_error" };
    var url = CONFIG.endpoint + "/download/" + encodeURIComponent(String(trackID)) +
      "?quality=" + encodeURIComponent(requested) + "&atmos=auto";
    if (onProgress) onProgress(0.05);
    var result = file.download(url, outputPath, { onProgress: function (written, total) {
      if (onProgress && total > 0) onProgress(0.05 + Math.min(1, written / total) * 0.9);
    }});
    if (!result || !result.success) return { success: false, error_message: result && result.error || "Audio transfer failed", error_type: result && result.error_type || "download_error" };
    var finalPath = result.path || outputPath;
    var measured = typeof gobackend !== "undefined" && gobackend && typeof gobackend.getAudioQuality === "function" ? gobackend.getAudioQuality(finalPath) : null;
    var expected = Number(options && (options.duration_ms || options.durationMs) || 0) / 1000;
    var actual = durationSeconds(measured);
    if (expected > 45 && actual > 0 && Math.abs(expected - actual) > 10) {
      deleteQuietly(finalPath);
      return { success: false, error_message: "Downloaded duration mismatch: expected " + Math.round(expected) + "s, got " + Math.round(actual) + "s", error_type: "duration_mismatch" };
    }
    if (requested === "lossless" && measured && measured.audioCodec && String(measured.audioCodec).toLowerCase() !== "flac") {
      deleteQuietly(finalPath);
      return { success: false, error_message: "Measured file is not FLAC; refusing a false lossless download", error_type: "quality_mismatch" };
    }
    if (onProgress) onProgress(1.0);
    return { success: true, file_path: finalPath, bit_depth: Number(measured && (measured.bitDepth || measured.bit_depth) || stream.bitDepth || 0), sample_rate: Number(measured && (measured.sampleRate || measured.sample_rate) || stream.sampleRate || 0), audio_codec: String(measured && (measured.audioCodec || measured.audio_codec) || format || "") };
  } catch (error) {
    return { success: false, error_message: error && error.message ? error.message : String(error), error_type: "runtime_error" };
  }
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  searchTracks: searchTracks,
  customSearch: customSearch,
  checkAvailability: checkAvailability,
  download: download,
  getDownloadUrl: function () { return null; }
});

log.info("[Emika] Extension loaded");
