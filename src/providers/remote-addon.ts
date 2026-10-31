import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;
type DirectStream = { url: string; format?: string; quality?: string; expiresAt: number };

const DIRECT_STREAM_TTL_MS = 30_000;
const MAX_DIRECT_STREAMS = 1_000;

export class RemoteAddonProvider implements QobuzProvider {
  private readonly directStreams = new Map<string, DirectStream>();

  constructor(private readonly config: Config, private readonly configuredBaseUrl?: string) {}

  async search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]> {
    const body = await this.request('/search', { q: query, quality, atmos });
    const items = isRecord(body) && Array.isArray(body.tracks) ? body.tracks : Array.isArray(body) ? body : [];
    const tracks = items.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
    for (const track of tracks) {
      if (track.streamURL) {
        this.directStreams.set(track.upstreamId, {
          url: track.streamURL,
          format: track.format,
          quality: track.audioQuality,
          expiresAt: Date.now() + Math.min(this.config.cacheTtlMs, DIRECT_STREAM_TTL_MS),
        });
      }
    }
    while (this.directStreams.size > MAX_DIRECT_STREAMS) {
      const oldest = this.directStreams.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.directStreams.delete(oldest);
    }
    return tracks;
  }

  async getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null> {
    if (!/^[A-Za-z0-9_:-]+$/.test(trackId)) return null;
    const cleanId = trackId.replace(/^dz:/, '');
    const direct = this.directStreams.get(trackId) ?? this.directStreams.get(cleanId);
    const directQuality = normalizeQuality(direct?.quality);
    if (direct && direct.expiresAt > Date.now() && (!directQuality || directQuality === quality)) {
      return {
        url: direct.url,
        format: direct.format,
        quality: direct.quality ?? quality,
        manifest: 'none',
        encrypted: false,
      };
    }
    if (direct) {
      this.directStreams.delete(trackId);
      this.directStreams.delete(cleanId);
    }

    try {
      const body = await this.request(`/stream/${encodeURIComponent(cleanId)}`, { quality, atmos });
      if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) return null;
      return {
        url: body.url, format: typeof body.format === 'string' ? body.format : undefined,
        codec: typeof body.codec === 'string' ? body.codec : undefined,
        container: typeof body.container === 'string' ? body.container : undefined,
        quality: typeof body.quality === 'string' ? body.quality : quality,
        manifest: body.manifest === 'hls' || body.manifest === 'dash' ? body.manifest : 'none',
        encrypted: body.encrypted === true,
        sampleRate: numberValue(body.sampleRate),
        bitDepth: numberValue(body.bitDepth),
        bitrate: numberValue(body.bitrate),
        audioMode: typeof body.audioMode === 'string' ? body.audioMode : undefined,
      };
    } catch (error) {
      return null; // Silent failure to protect the server
    }
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    let base = (this.configuredBaseUrl ?? this.config.deezerBaseUrl ?? 'https://bitchord-hires-addon.vercel.app').trim();
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = 'https://' + base;
    }
    try {
      const parsed = new URL(base);
      if (parsed.pathname.endsWith('/manifest.json')) {
        parsed.pathname = parsed.pathname.slice(0, -'/manifest.json'.length) || '/';
        parsed.search = '';
        parsed.hash = '';
        base = parsed.toString().replace(/\/$/, '');
      }
    } catch {
      throw new UpstreamError(502, 'Remote addon base URL is invalid');
    }
    
    const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    
    try {
      const response = await fetch(url, { 
        headers: { 
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9,th;q=0.8',
          'user-agent': 'BitChord/v1.9',
          'referer': base.replace(/\/$/, '') + '/',
          'origin': base.replace(/\/$/, '')
        }, 
        signal: controller.signal 
      });
      let body: unknown;
      try { 
        body = await response.json(); 
      } catch { 
        throw new UpstreamError(502, 'Remote backend returned invalid JSON'); 
      }
      
      if (!response.ok) {
        throw new UpstreamError(response.status >= 500 ? 502 : response.status, `Remote backend request failed (HTTP ${response.status})`);
      }
      return body;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(502, 'Remote backend request failed');
    } finally { 
      clearTimeout(timeout); 
    }
  }
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const artist = typeof raw.artist === 'string' ? raw.artist : isRecord(raw.artist) && typeof raw.artist.name === 'string' ? raw.artist.name : undefined;
  const album = typeof raw.album === 'string' ? raw.album : isRecord(raw.album) && typeof raw.album.title === 'string' ? raw.album.title : undefined;
  return {
    upstreamId: String(id), title: title.trim(), artist, album,
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL:
      typeof raw.artworkURL === 'string' ? raw.artworkURL :
      typeof raw.albumArtworkURL === 'string' ? raw.albumArtworkURL :
      typeof raw.artwork === 'string' ? raw.artwork : undefined,
    streamURL: typeof raw.streamURL === 'string' && /^https:\/\//i.test(raw.streamURL) ? raw.streamURL : undefined,
    format: typeof raw.format === 'string' ? raw.format : undefined,
    audioQuality: typeof raw.audioQuality === 'string' ? raw.audioQuality : undefined,
    audioModes: Array.isArray(raw.audioModes) ? raw.audioModes.filter((value): value is string => typeof value === 'string') : undefined,
    atmos: typeof raw.atmos === 'boolean' ? raw.atmos : undefined,
  };
}

function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeQuality(value?: string): Quality | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'LOSSLESS' || normalized === 'HIGH' || normalized === 'LOW') return normalized;
  return undefined;
}
