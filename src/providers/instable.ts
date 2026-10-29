import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;

const DEFAULT_BASE_URL    = 'https://instable.arcod.xyz';
const DEFAULT_SEARCH_PATH = '/api/search';
const DEFAULT_STREAM_PATH = '/api/player/stream';
const DEFAULT_SOURCE      = 'qobuz';

// Never retry — client-fault or permanent
const STATUS_NO_RETRY = new Set([400, 401, 403, 404, 410, 422]);
// Retry with backoff
const STATUS_RETRYABLE = new Set([408, 425, 429]);

export class InstableProvider implements QobuzProvider {
  private readonly baseUrl: string;
  private readonly searchPath: string;
  private readonly streamPath: string;
  private readonly source: string;
  private readonly sendSource: boolean;
  private readonly qualityIds: Record<Quality, string>;
  private readonly apiToken?: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly config: Config) {
    this.baseUrl     = (config.instableBaseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    this.searchPath  = normalizePath(config.instableSearchPath ?? DEFAULT_SEARCH_PATH);
    this.streamPath  = normalizePath(config.instableStreamPath ?? DEFAULT_STREAM_PATH);
    this.source      = (config.instableSource ?? DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
    this.sendSource  = config.instableSendSource === true;
    this.qualityIds  = {
      LOSSLESS: (config.instableQualityLossless ?? '27').trim() || '27',
      HIGH:     (config.instableQualityHigh     ?? '6').trim()  || '6',
      LOW:      (config.instableQualityLow      ?? '5').trim()  || '5',
    };
    this.apiToken    = config.instableApiToken?.trim() || undefined;
    this.userAgent   = config.instableUserAgent?.trim() || defaultUserAgent();
    this.timeoutMs   = config.requestTimeoutMs;
    this.maxAttempts = config.upstreamRetries;
  }

  // ─── search ────────────────────────────────────────────────────────
  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    const params: Record<string, string> = { q: query };

    // /api/get-music requires source; /api/search ignores it (harmless)
    if (this.sendSource || this.searchPath.includes('get-music')) {
      params.source = this.source;
      if (this.searchPath.includes('get-music')) params.offset = '0';
    }
    if (this.searchPath.includes('/search') && !this.searchPath.includes('get-music')) {
      params.limit = '10';
    }

    const body = await this.request(this.searchPath, params);
    const items = extractTrackItems(body);
    return items.filter(isRecord).map(toTrack).filter((t): t is QobuzTrack => t !== null);
  }

  // ─── stream ────────────────────────────────────────────────────────
  async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    const path = `${this.streamPath}/${encodeURIComponent(trackId)}`;
    const params: Record<string, string> = { quality: this.qualityIds[quality] };

    try {
      const body = await this.request(path, params);
      return toStream(body, quality);
    } catch (error) {
      // 410 = URL expired, 404 = track gone, 401/403 = auth, 400 = bad params
      // → return null so BitChord can trigger a fresh search
      if (error instanceof UpstreamError && STATUS_NO_RETRY.has(error.status)) return null;
      // Server / network failures bubble up so BitChord knows provider is sick
      throw error;
    }
  }

  // ─── HTTP helper ──────────────────────────────────────────────────
  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9,th;q=0.8',
          'user-agent': this.userAgent,
          referer: `${this.baseUrl}/`,
          origin: this.baseUrl,
        };
        if (this.apiToken) headers.authorization = `Bearer ${this.apiToken}`;

        const response = await fetch(url, { headers, signal: controller.signal });

        // instable returns text/plain content-type but valid JSON — parse defensively
        let body: unknown;
        try { body = await response.json(); }
        catch { throw new UpstreamError(502, 'Instable returned invalid JSON'); }

        if (!response.ok) {
          if (response.status === 404) throw new UpstreamError(404, 'Instable track not found');
          if (response.status === 410) throw new UpstreamError(410, 'Instable stream gone (expired URL)');
          if (response.status === 401 || response.status === 403) throw new UpstreamError(401, 'Instable auth required');
          if (response.status === 400) throw new UpstreamError(400, 'Instable bad request');

          if (!isRetryable(response.status) || attempt >= this.maxAttempts) {
            throw new UpstreamError(502, `Instable request failed (HTTP ${response.status})`);
          }
          lastError = new UpstreamError(502, `Instable request failed (HTTP ${response.status})`);
        }
        else if (isRecord(body) && body.success === false) {
          const msg = typeof body.error === 'string' ? body.error : 'Instable request failed';
          if (/auth/i.test(msg)) throw new UpstreamError(401, 'Instable auth required');
          if (attempt >= this.maxAttempts) throw new UpstreamError(502, msg);
          lastError = new UpstreamError(502, msg);
        }
        else {
          return body;
        }
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (!isRetryable(error.status) || attempt >= this.maxAttempts) throw error;
          lastError = error;
        } else {
          lastError = error;
        }
      } finally {
        clearTimeout(timer);
      }

      // exponential backoff + jitter
      await delay(250 * 2 ** attempt + Math.floor(Math.random() * 200));
    }

    throw lastError instanceof UpstreamError
      ? lastError
      : new UpstreamError(502, 'Instable request failed');
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function extractTrackItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  const data = isRecord(body.data) ? body.data : body;

  // {data:{tracks:{items:[...]}}} — canonical /api/search shape
  if (isRecord(data.tracks) && Array.isArray(data.tracks.items)) return data.tracks.items;
  // {data:{tracks:[...]}}
  if (Array.isArray(data.tracks)) return data.tracks;
  // {tracks:{items:[...]}}
  if (isRecord(body.tracks) && Array.isArray(body.tracks.items)) return body.tracks.items;
  // {tracks:[...]} or [...]
  if (Array.isArray(body.tracks)) return body.tracks;
  return [];
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id;
  const rawTitle = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof rawTitle !== 'string' || !rawTitle.trim()) {
    return null;
  }

  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : undefined;
  const title = version ? `${rawTitle.trim()} (${version})` : rawTitle.trim();

  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const album     = isRecord(raw.album)     ? raw.album     : undefined;
  const image     = album && isRecord(album.image) ? album.image : undefined;

  const bitDepth = typeof raw.maximum_bit_depth === 'number' ? raw.maximum_bit_depth : undefined;
  const hires    = raw.hires === true;

  let audioQuality: string | undefined;
  if (hires) audioQuality = 'HI_RES_LOSSLESS';
  else if (bitDepth !== undefined && bitDepth >= 16) audioQuality = 'LOSSLESS';

  return {
    upstreamId: String(id),
    title,
    artist:     performer && typeof performer.name === 'string' ? performer.name : undefined,
    album:      album && typeof album.title === 'string' ? album.title : undefined,
    duration:   typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL: image && typeof image.large === 'string' ? image.large : undefined,
    format:     bitDepth !== undefined && bitDepth >= 16 ? 'flac' : undefined,
    audioQuality,
  };
}

function toStream(body: unknown, requested: Quality): QobuzStream {
  if (!isRecord(body)) throw new UpstreamError(502, 'Instable stream response malformed');
  const data = isRecord(body.data) ? body.data : body;

  const url =
    (typeof data.url === 'string' && data.url) ||
    (isRecord(data.stream) && typeof data.stream.url === 'string' && data.stream.url) ||
    undefined;

  if (!url || !/^https:\/\//i.test(url)) {
    throw new UpstreamError(502, 'Instable stream missing playable url');
  }

  const mime =
    (typeof data.mimeType === 'string' && data.mimeType) ||
    (typeof data.format   === 'string' && data.format)   ||
    undefined;
  const format = mime && mime.includes('/') ? mime.split('/').pop() : mime;

  return {
    url,
    format: format?.toLowerCase(),
    quality: requested,
    manifest: 'none',
    encrypted: false,
  };
}

function normalizePath(p: string): string {
  const trimmed = p.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function defaultUserAgent(): string {
  return 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
         '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
}

function isRetryable(status: number): boolean {
  return STATUS_RETRYABLE.has(status) || status >= 500;
}

function isRecord(v: unknown): v is RecordValue {
  return typeof v === 'object' && v !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
