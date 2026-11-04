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
  private readonly trackMetadata = new Map<string, Pick<QobuzTrack, 'sampleRate' | 'bitDepth' | 'audioQuality' | 'audioMode' | 'audioModes' | 'atmos'>>();
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
      HI_RES:  (config.instableQualityHiRes  ?? '27').trim() || '27',
      // Qobuz quality IDs: 27 = max Hi-Res lossless, 6 = CD lossless.
      // Keep both values configurable because mirrors may expose a different map.
      LOSSLESS: (config.instableQualityLossless ?? '6').trim() || '6',
      HIGH:     (config.instableQualityHigh     ?? '5').trim()  || '5',
      LOW:      (config.instableQualityLow      ?? '').trim(),
    };
    this.apiToken    = config.instableApiToken?.trim() || undefined;
    this.userAgent   = config.instableUserAgent?.trim() || config.userAgent || defaultUserAgent();
    this.timeoutMs   = config.requestTimeoutMs;
    this.maxAttempts = config.upstreamRetries;
  }

  // ─── search ────────────────────────────────────────────────────────
  async search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]> {
    const params: Record<string, string> = { q: query };

    // /api/get-music requires source; /api/search ignores it (harmless)
    if (this.sendSource || this.searchPath.includes('get-music')) {
      params.source = this.source;
      if (this.searchPath.includes('get-music')) params.offset = '0';
    }
    if (this.searchPath.includes('/search') && !this.searchPath.includes('get-music')) {
      params.limit = '10';
    }
    params.atmos = normalizeAtmos(atmos);

    const body = await this.request(this.searchPath, params);
    const items = extractTrackItems(body);
    const tracks = items.filter(isRecord)
      .map((item) => toTrack(item, quality, this.config.enabledQualityTiers.has('HI_RES')))
      .filter((t): t is QobuzTrack => t !== null);
    for (const track of tracks) {
      this.trackMetadata.set(metadataKey(track.upstreamId, quality, atmos), {
        sampleRate: track.sampleRate,
        bitDepth: track.bitDepth,
        audioQuality: track.audioQuality,
        audioMode: track.audioMode,
        audioModes: track.audioModes,
        atmos: track.atmos,
      });
    }
    while (this.trackMetadata.size > 2_000) {
      const oldest = this.trackMetadata.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.trackMetadata.delete(oldest);
    }
    return tracks;
  }

  // ─── stream ────────────────────────────────────────────────────────
  async getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null> {
    const metadata = this.trackMetadata.get(metadataKey(trackId, quality, atmos));
    // BitChord uses LOSSLESS for both CD lossless and Hi-Res lossless. If the
    // preceding search identified this exact track as Hi-Res, request the
    // provider's dedicated Hi-Res rendition instead of silently downgrading
    // it to Qobuz quality 6.
    const effectiveQuality = quality === 'LOSSLESS' && atmos !== 'on' && this.config.enabledQualityTiers.has('HI_RES') && isHiResMetadata(metadata)
      ? 'HI_RES'
      : quality;
    const qualityId = this.qualityIds[effectiveQuality];
    if (!qualityId) return null;
    const path = `${this.streamPath}/${encodeURIComponent(trackId)}`;
    const params: Record<string, string> = {
      quality: qualityId,
      atmos: normalizeAtmos(atmos),
    };

    try {
      const body = await this.request(path, params);
      const stream = toStream(body, quality, effectiveQuality);
      // Metadata is only safe to reuse for the exact rendition that was searched.
      // Do not let a Hi-Res search annotate a later Lossless/High/Atmos stream.
      // For BitChord's LOSSLESS request, effectiveQuality may intentionally be
      // HI_RES; in that case the metadata and provider quality ID still match.
      if (!metadata || effectiveQuality !== 'HI_RES' && quality !== effectiveQuality) return stream;
      return {
        ...stream,
        ...(effectiveQuality === 'HI_RES' ? {
          sampleRate: stream.sampleRate ?? metadata.sampleRate,
          bitDepth: stream.bitDepth ?? metadata.bitDepth,
          audioQuality: stream.audioQuality ?? metadata.audioQuality,
        } : {}),
        audioMode: stream.audioMode ?? metadata.audioMode,
        audioModes: stream.audioModes ?? metadata.audioModes,
        atmos: stream.atmos ?? metadata.atmos,
      };
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

      // Exponential backoff + jitter only when another attempt is scheduled.
      // Do not add an artificial delay after the final attempt.
      if (attempt < this.maxAttempts) {
        await delay(250 * 2 ** attempt + Math.floor(Math.random() * 200));
      }
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

function metadataKey(trackId: string, quality: Quality, atmos: string): string {
  return `${trackId}\u0000${quality}\u0000${normalizeAtmos(atmos)}`;
}

function isHiResMetadata(metadata: Pick<QobuzTrack, 'sampleRate' | 'bitDepth' | 'audioQuality'> | undefined): boolean {
  if (!metadata) return false;
  return metadata.audioQuality?.toUpperCase() === 'HI_RES_LOSSLESS' ||
    (metadata.sampleRate ?? 0) > 48000 ||
    (metadata.bitDepth ?? 0) > 16;
}

function toTrack(raw: RecordValue, requested: Quality, hiResEnabled: boolean): QobuzTrack | null {
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
  const maximumSamplingRate = typeof raw.maximum_sampling_rate === 'number' ? raw.maximum_sampling_rate : undefined;
  const hires    = raw.hires === true;

  const isHighQuality = requested === 'HIGH';
  const hasHiResEvidence = hires || (maximumSamplingRate ?? 0) > 48000 || (bitDepth ?? 0) > 16;
  const suppressHiResMetadata = isHighQuality || requested === 'LOSSLESS' && !hiResEnabled && hasHiResEvidence;
  // Quality 6 is the selected CD-lossless rendition. When Hi-Res is disabled,
  // Instable may still return only the catalogue's maximum (Hi-Res) metadata,
  // or omit rendition metadata entirely. Do not expose that maximum on a
  // LOSSLESS search; describe the actual selected rendition instead.
  const selectedLosslessMetadata = requested === 'LOSSLESS' && !hiResEnabled;
  const losslessSampleRate = selectedLosslessMetadata ? 44_100 : undefined;
  const losslessBitDepth = selectedLosslessMetadata ? 16 : undefined;
  let audioQuality: string | undefined;
  if (isHighQuality) audioQuality = 'HIGH';
  else if (hires && !suppressHiResMetadata) audioQuality = 'HI_RES_LOSSLESS';
  else if (selectedLosslessMetadata || bitDepth !== undefined && bitDepth >= 16) audioQuality = 'LOSSLESS';

  return {
    upstreamId: String(id),
    title,
    artist:     performer && typeof performer.name === 'string' ? performer.name : undefined,
    album:      album && typeof album.title === 'string' ? album.title : undefined,
    duration:   typeof raw.duration === 'number' ? raw.duration : undefined,
    isrc:       stringValue(raw.isrc ?? raw.ISRC ?? raw.isrc_code),
    artworkURL: image && typeof image.large === 'string' ? image.large : undefined,
    format:     isHighQuality ? 'mp3' : selectedLosslessMetadata || bitDepth !== undefined && bitDepth >= 16 ? 'flac' : undefined,
    audioQuality,
    sampleRate: selectedLosslessMetadata
      ? losslessSampleRate
      : !suppressHiResMetadata && maximumSamplingRate !== undefined
        ? (maximumSamplingRate < 1000 ? maximumSamplingRate * 1000 : maximumSamplingRate)
        : undefined,
    bitDepth: selectedLosslessMetadata ? losslessBitDepth : suppressHiResMetadata ? undefined : bitDepth,
  };
}

function toStream(body: unknown, requested: Quality, effectiveQuality = requested): QobuzStream {
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
  const normalizedFormat = format?.toLowerCase();
  const isSelectedCdLossless = effectiveQuality === 'LOSSLESS' && normalizedFormat === 'flac';

  return {
    url,
    format: normalizedFormat,
    codec: normalizedFormat,
    container: normalizedFormat === 'flac' ? 'flac' : undefined,
    quality: requested,
    manifest: 'none',
    encrypted: false,
    expiresAt: numberValue(data.expiresAt ?? data.expires_at ?? data.expiry),
    sampleRate: numberValue(data.sampleRate) ?? (isSelectedCdLossless ? 44_100 : undefined),
    bitDepth: numberValue(data.bitDepth) ?? (isSelectedCdLossless ? 16 : undefined),
    bitrate: numberValue(data.bitrate),
    audioMode: stringValue(data.audioMode ?? data.audio_mode),
    audioModes: stringArray(data.audioModes ?? data.audio_modes),
    atmos: booleanValue(data.atmos ?? data.isAtmos ?? data.dolbyAtmos),
    streamQuality: stringValue(data.streamQuality ?? data.stream_quality),
    audioQuality: stringValue(data.audioQuality ?? data.audio_quality) ?? (isSelectedCdLossless ? 'LOSSLESS' : undefined),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  return values.length > 0 ? values : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizePath(p: string): string {
  const trimmed = p.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeAtmos(value: string): 'auto' | 'on' | 'off' {
  const normalized = value.trim().toLowerCase();
  return normalized === 'on' || normalized === 'off' ? normalized : 'auto';
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
