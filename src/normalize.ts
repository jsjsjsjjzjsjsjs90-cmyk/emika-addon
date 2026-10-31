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
    if (!namespace) return payload.trim() || undefined;
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
    artworkURL: absoluteUrl(track.artworkURL), streamURL: absoluteUrl(track.streamURL), format: track.format?.toLowerCase(),
    audioQuality: track.audioQuality?.trim(), audioModes: track.audioModes, atmos: track.atmos,
  };
}

export function streamResponse(stream: QobuzStream, requested: Quality): QobuzStream {
  if (!/^https:\/\//i.test(stream.url) || stream.encrypted === true) throw new Error('stream is not an openable HTTPS rendition');
  if (stream.manifest && !['none', 'hls', 'dash'].includes(stream.manifest)) throw new Error('unsupported manifest type');
  const format = stream.format?.trim().toLowerCase();
  const codec = stream.codec?.trim().toLowerCase() ?? inferredCodec(format);
  const container = stream.container?.trim().toLowerCase() ?? inferredContainer(format);
  return {
    ...stream,
    format,
    quality: stream.quality ?? requested,
    codec,
    container,
    manifest: stream.manifest ?? inferredManifest(format),
    encrypted: stream.encrypted ?? false,
    sampleRate: positiveNumber(stream.sampleRate),
    bitDepth: positiveInteger(stream.bitDepth),
    bitrate: positiveNumber(stream.bitrate),
  };
}

function inferredCodec(format?: string): string | undefined {
  if (format === 'flac') return 'flac';
  if (format === 'mp3') return 'mp3';
  if (format === 'aac') return 'aac';
  return undefined;
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

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret || DEFAULT_ID_SECRET).update(encoded).digest('base64url').slice(0, 16);
}

function absoluteUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.toString() : undefined; } catch { return undefined; }
}
