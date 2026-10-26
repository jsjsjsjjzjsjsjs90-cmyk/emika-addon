import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;

const DEFAULT_BASE_URL = 'https://music-api.gdstudio.xyz';
const DEFAULT_SOURCES = ['qobuz', 'tidal'];

const KNOWN_SOURCES = new Set([
  'qobuz', 'tidal', 'spotify', 'ytmusic', 'netease',
  'tencent', 'joox', 'migu', 'kugou', 'kuwo', 'ximalaya',
]);

interface CacheEntry { expiresAt: number; tracks: QobuzTrack[] }

export class GdstudioProvider implements QobuzProvider {
  private readonly baseUrl: string;
  private readonly sources: string[];
  private readonly dedupe: boolean;
  private readonly perSourceCount: number;
  private readonly searchCache = new Map<string, CacheEntry>();
  private readonly searchCacheTtlMs = 30_000;

  constructor(private readonly config: Config, sources?: string | string[]) {
    this.baseUrl = (process.env.GDSTUDIO_BASE_URL ?? DEFAULT_BASE_URL)
      .trim().replace(/\/$/, '');

    const raw = sources ?? process.env.GDSTUDIO_SOURCE ?? DEFAULT_SOURCES.join(',');
    const list = Array.isArray(raw) ? raw : raw.split(',');
    const cleaned = list.map(s => s.trim()).filter(Boolean);
    this.sources = cleaned.length ? cleaned : [...DEFAULT_SOURCES];

    this.dedupe = process.env.GDSTUDIO_DEDUPE === '1';

    const parsed = Number(process.env.GDSTUDIO_COUNT ?? '20');
    this.perSourceCount = Number.isFinite(parsed) && parsed > 0 && parsed <= 50 ? parsed : 20;
  }

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    const cacheKey = `${query}\u0000${this.sources.join(',')}\u0000${this.perSourceCount}`;
    const hit = this.searchCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.tracks.map(t => ({ ...t }));
    }

    const settled = await Promise.allSettled(
      this.sources.map(source => this.searchOne(source, query)),
    );

    const merged: QobuzTrack[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      if (result.status !== 'fulfilled') continue;
      const source = this.sources[i];
      for (const track of result.value) {
        merged.push({ ...track, upstreamId: `${source}:${track.upstreamId}` });
      }
    }

    const out = this.dedupe ? dedupeByTitleArtist(merged) : merged;

    if (this.searchCache.size >= 100) {
      const first = this.searchCache.keys().next().value as string;
      this.searchCache.delete(first);
    }
    this.searchCache.set(cacheKey, { expiresAt: Date.now() + this.searchCacheTtlMs, tracks: out });
    return out.map(t => ({ ...t }));
  }

  async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    const sep = trackId.indexOf(':');
    let source: string;
    let id: string;
    if (sep > 0) {
      source = trackId.slice(0, sep);
      id = trackId.slice(sep + 1);
    } else {
      source = this.sources[0];
      id = trackId;
    }

    if (!KNOWN_SOURCES.has(source)) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;

    try {
      const body = await this.request({ types: 'url', source, id, br: bitrateId(quality) });
      if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) return null;
      const br = typeof body.br === 'number' ? body.br : undefined;
      return {
        url: body.url,
        format: inferFormat(body.url),
        quality: br ? String(br) : quality,
        bitrate: br,
        manifest: 'none',
        encrypted: false,
      };
    } catch {
      return null;
    }
  }

  private async searchOne(source: string, query: string): Promise<QobuzTrack[]> {
    const body = await this.request({
      types: 'search', source, name: query, count: String(this.perSourceCount), pages: '1',
    });
    if (!Array.isArray(body)) return [];
    return body
      .filter(isRecord)
      .map((raw) => toTrack(raw, source, this.baseUrl))
      .filter((t): t is QobuzTrack => t !== null);
  }

  private async request(params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/api.php`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timeoutMs = Math.min(this.config.requestTimeoutMs, 7500);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9,th;q=0.8',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
          referer: `${this.baseUrl}/`,
          origin: this.baseUrl,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status >= 500 ? 502 : response.status === 404 ? 404 : 400;
        throw new UpstreamError(status, `Gdstudio request failed (HTTP ${response.status})`);
      }
      try {
        return await response.json();
      } catch {
        throw new UpstreamError(502, 'Gdstudio returned invalid JSON');
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(502, 'Gdstudio request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function dedupeByTitleArtist(tracks: QobuzTrack[]): QobuzTrack[] {
  const seen = new Set<string>();
  const out: QobuzTrack[] = [];
  for (const track of tracks) {
    const key = `${track.title.toLowerCase()}\u0000${(track.artist ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function toTrack(raw: RecordValue, source: string, baseUrl: string): QobuzTrack | null {
  const id = raw.id ?? raw.url_id;
  const title = raw.name;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;

  const artists = Array.isArray(raw.artist)
    ? raw.artist.filter((x): x is string => typeof x === 'string')
    : [];
  const picId = raw.pic_id ?? raw.pic;
  const artworkURL = picId
    ? `${baseUrl}/api.php?types=pic&source=${encodeURIComponent(source)}&id=${encodeURIComponent(String(picId))}&size=300`
    : undefined;

  return {
    upstreamId: String(id),
    title: title.trim(),
    artist: artists.length ? artists.join(', ') : undefined,
    album: typeof raw.album === 'string' ? raw.album : undefined,
    artworkURL,
  };
}

function bitrateId(quality: Quality): string {
  if (quality === 'LOSSLESS') return '999';
  if (quality === 'HIGH') return '320';
  return '128';
}

function inferFormat(url: string): string | undefined {
  const m = /\.(flac|mp3|m4a|aac|ogg|wav)(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}
