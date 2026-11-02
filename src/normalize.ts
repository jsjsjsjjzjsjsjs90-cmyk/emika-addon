import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PublicTrack, QobuzStream, QobuzTrack, Quality } from './types.js';

const DEFAULT_ID_SECRET = 'qobuz-bitchord-id-secret-v1';

export function publicId(track: QobuzTrack, secret = DEFAULT_ID_SECRET, namespace?: string): string {
  const payload = namespace ? `${namespace}\u0000${track.upstreamId}` : track.upstreamId;
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = sign(encoded, secret);
  return `qobuz_${encoded}_${signature}`;
}

export function upstreamIdFromPublicId(id: string, secret = DEFAULT_ID_SECRET, namespace?: string): string | undefined {
  const match = /^qobuz_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{16})$/.exec(id);
  if (!match) return undefined;
  const [encoded, supplied] = [match[1], match[2]];
  const expected = sign(encoded, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!namespace) return payload.includes('\u0000') ? undefined : payload.trim() || undefined;
    const separator = payload.indexOf('\u0000');
    if (separator <= 0 || payload.slice(0, separator) !== namespace) return undefined;
    return payload.slice(separator + 1).trim() || undefined;
  } catch { return undefined; }
}

export function normalizeTrack(track: QobuzTrack, secret?: string, namespace?: string): PublicTrack {
  if (!track.upstreamId.trim() || !track.title.trim()) throw new Error('provider returned an unusable track');
  const normalizedTrack = { ...track, upstreamId: track.upstreamId.trim(), title: track.title.trim() };
  return {
    id: publicId(normalizedTrack, secret, namespace), title: normalizedTrack.title,
    artist: track.artist?.trim() || undefined, album: track.album?.trim() || undefined,
    duration: Number.isFinite(track.duration) && (track.duration as number) >= 0 ? track.duration : undefined,
    ...(normalizeIsrc(track.isrc) ? { isrc: normalizeIsrc(track.isrc) } : {}),
    artworkURL: absoluteUrl(track.artworkURL), streamURL: absoluteUrl(track.streamURL), format: track.format?.toLowerCase(),
    audioQuality: track.audioQuality?.trim(), audioMode: track.audioMode?.trim(),
    audioModes: track.audioModes, atmos: track.atmos,
    sampleRate: normalizeSampleRate(track.sampleRate), bitDepth: positiveInteger(track.bitDepth), bitrate: normalizeBitrate(track.bitrate),
  };
}

export function streamResponse(stream: QobuzStream, requested: Quality): QobuzStream {
  if (!/^https:\/\//i.test(stream.url) || stream.encrypted === true) throw new Error('stream is not an openable HTTPS rendition');
  if (stream.manifest && !['none', 'hls', 'dash'].includes(stream.manifest)) throw new Error('unsupported manifest type');
  const format = normalizeFormat(stream.format);
  const codec = normalizeCodec(stream.codec) ?? inferredCodec(format);
  const container = stream.container?.trim().toLowerCase() ?? inferredContainer(format);
  return {
    ...stream,
    format,
    quality: stream.quality ?? requested,
    codec,
    container,
    manifest: stream.manifest ?? inferredManifest(format),
    encrypted: stream.encrypted ?? false,
    ...(positiveNumber(stream.expiresAt) ? { expiresAt: positiveNumber(stream.expiresAt) } : {}),
    sampleRate: normalizeSampleRate(stream.sampleRate),
    bitDepth: positiveInteger(stream.bitDepth),
    bitrate: normalizeBitrate(stream.bitrate),
  };
}

function inferredCodec(format?: string): string | undefined {
  if (format === 'flac') return 'flac';
  if (format === 'mp3') return 'mp3';
  if (format === 'aac') return 'aac';
  return undefined;
}

function normalizeFormat(value?: string): string | undefined {
  const format = value?.trim().toLowerCase();
  if (format === 'mpeg' || format === 'x-mpeg' || format === 'mp2') return 'mp3';
  if (format === 'application/dash+xml' || format === 'mpegdash' || format === 'mpd') return 'dash';
  if (format === 'application/vnd.apple.mpegurl' || format === 'application/x-mpegurl' || format === 'm3u8') return 'hls';
  return format;
}

function normalizeCodec(value?: string): string | undefined {
  const codec = value?.trim().toLowerCase();
  if (codec === 'mpeg' || codec === 'x-mpeg' || codec === 'mp2') return 'mp3';
  if (codec === 'eac3_joc' || codec === 'eac3-joc' || codec === 'ec-3' || codec === 'eac3') return 'eac3-joc';
  return codec;
}

function inferredContainer(format?: string): string | undefined {
  if (format === 'flac') return 'flac';
  if (format === 'mp3') return 'mpeg';
  if (format === 'm4a' || format === 'mp4') return 'mp4';
  return undefined;
}

function inferredManifest(format?: string): 'none' | 'hls' | 'dash' {
  if (format === 'hls') return 'hls';
  if (format === 'dash') return 'dash';
  return 'none';
}

function positiveNumber(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInteger(value?: number): number | undefined {
  return positiveNumber(value) && Number.isInteger(value) ? value : undefined;
}

function normalizeSampleRate(value?: number): number | undefined {
  const normalized = positiveNumber(value);
  if (normalized === undefined) return undefined;
  return normalized < 1000 ? normalized * 1000 : normalized;
}

function normalizeBitrate(value?: number): number | undefined {
  const normalized = positiveNumber(value);
  if (normalized === undefined) return undefined;
  return normalized < 10000 ? normalized * 1000 : normalized;
}

function normalizeIsrc(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : undefined;
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret || DEFAULT_ID_SECRET).update(encoded).digest('base64url').slice(0, 16);
}

function absoluteUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.toString() : undefined; } catch { return undefined; }
}
