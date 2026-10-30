import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;

export class RemoteAddonProvider implements QobuzProvider {
  private readonly directStreams = new Map<string, { url: string; format?: string; quality?: string }>();

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
        });
      }
    }
    return tracks;
  }

  async getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null> {
    if (!/^[A-Za-z0-9_:-]+$/.test(trackId)) return null;
    const cleanId = trackId.replace(/^dz:/, '');
    const direct = this.directStreams.get(trackId) ?? this.directStreams.get(cleanId);
    if (direct) {
      return {
        url: direct.url,
        format: direct.format,
        quality: direct.quality ?? quality,
        manifest: 'none',
        encrypted: false,
      };
    }

    try {
      const body = await this.request(`/stream/${encodeURIComponent(cleanId)}`, { quality, atmos });
      if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) return null;
      return {
        url: body.url, format: typeof body.format === 'string' ? body.format : undefined,
        quality: typeof body.quality === 'string' ? body.quality : quality,
        manifest: body.manifest === 'hls' || body.manifest === 'dash' ? body.manifest : 'none',
        encrypted: body.encrypted === true,
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
          'user-agent': 'BitChord/1.8.1',
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
    artworkURL: typeof raw.artworkURL === 'string' ? raw.artworkURL : typeof raw.artwork === 'string' ? raw.artwork : undefined,
    streamURL: typeof raw.streamURL === 'string' && /^https:\/\//i.test(raw.streamURL) ? raw.streamURL : undefined,
    format: typeof raw.format === 'string' ? raw.format : undefined,
    audioQuality: typeof raw.audioQuality === 'string' ? raw.audioQuality : undefined,
  };
}

function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }
