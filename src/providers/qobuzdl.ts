import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type JsonRecord = Record<string, unknown>;

/** Adapter for the public Qobuz-DL-compatible JSON API. */
export class QobuzDlProvider implements QobuzProvider {
  private readonly trackMetadata = new Map<string, Pick<QobuzTrack, 'sampleRate' | 'bitDepth' | 'audioQuality' | 'format'>>();

  constructor(private readonly config: Config) {}

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    const body = await this.request('/api/get-music', { q: query, offset: '0' });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const tracks = data && isRecord(data.tracks) && Array.isArray(data.tracks.items) ? data.tracks.items : [];
    const normalized = tracks.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
    for (const track of normalized) {
      this.trackMetadata.set(track.upstreamId, {
        sampleRate: track.sampleRate,
        bitDepth: track.bitDepth,
        audioQuality: track.audioQuality,
        format: track.format,
      });
    }
    while (this.trackMetadata.size > 2_000) {
      const oldest = this.trackMetadata.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.trackMetadata.delete(oldest);
    }
    return normalized;
  }

  async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    const body = await this.request('/api/download-music', { track_id: trackId, quality: qualityId(quality) });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const url = data && typeof data.url === 'string' ? data.url : undefined;
    if (!url || !/^https:\/\//i.test(url)) return null;
    // The upstream endpoint returns only a URL. Reuse only metadata captured
    // from the preceding search response; never guess from the requested tier.
    const metadata = this.trackMetadata.get(trackId);
    return {
      url,
      format: metadata?.format,
      quality,
      manifest: 'none',
      encrypted: false,
      sampleRate: metadata?.sampleRate,
      bitDepth: metadata?.bitDepth,
      audioQuality: metadata?.audioQuality,
    };
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.config.apiBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.upstreamRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': this.config.userAgent }, signal: controller.signal });
        const rawBody = await response.text();
        let body: unknown;
        try { body = JSON.parse(rawBody); } catch {
          if (isPlanLimitText(rawBody)) throw new UpstreamError(503, planLimitMessage());
          throw new UpstreamError(502, 'Qobuz-DL provider returned invalid JSON');
        }
        if (!response.ok) {
          const error = isPlanLimitBody(body)
            ? new UpstreamError(503, planLimitMessage())
            : new UpstreamError(retryableStatus(response.status) ? 502 : response.status === 404 ? 404 : 400, upstreamMessage(body));
          if (!retryableStatus(response.status) || attempt >= this.config.upstreamRetries) throw error;
          lastError = error;
        } else if (isRecord(body) && body.success === false) {
          const error = isPlanLimitBody(body)
            ? new UpstreamError(503, planLimitMessage())
            : new UpstreamError(502, upstreamMessage(body));
          if (attempt >= this.config.upstreamRetries) throw error;
          lastError = error;
        } else return body;
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= this.config.upstreamRetries) throw error;
        }
        lastError = error;
      } finally { clearTimeout(timeout); }
      await delay(200 * 2 ** attempt);
    }
    throw lastError instanceof UpstreamError ? lastError : new UpstreamError(502, 'Qobuz-DL provider request failed');
  }
}

function retryableStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function qualityId(quality: Quality): string {
  // IDs verified from the Qobuz-DL route schema: 27, 7, 6, and 5.
  // Keep CD lossless distinct from the dedicated Hi-Res rendition.
  if (quality === 'HI_RES') return '27';
  if (quality === 'LOSSLESS') return '6';
  return '5';
}

function toTrack(raw: JsonRecord): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const album = isRecord(raw.album) ? raw.album : undefined;
  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const image = album && isRecord(album.image) ? album.image : undefined;
  const artworkURL = image && typeof image.large === 'string' ? image.large : undefined;
  const maxBitDepth = typeof raw.maximum_bit_depth === 'number' ? raw.maximum_bit_depth : undefined;
  const sampleRate = normalizeSampleRate(raw.maximum_sampling_rate);
  const isHiRes = (sampleRate ?? 0) > 48_000 || (maxBitDepth ?? 0) > 16;
  return {
    upstreamId: String(id), title: title.trim(),
    artist: performer && typeof performer.name === 'string' ? performer.name : undefined,
    album: album && typeof album.title === 'string' ? album.title : undefined,
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL, format: maxBitDepth ? 'flac' : undefined,
    audioQuality: maxBitDepth ? (isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS') : undefined,
    sampleRate,
    bitDepth: maxBitDepth,
  };
}

function normalizeSampleRate(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const hz = value < 1_000 ? value * 1_000 : value;
  return Math.round(hz);
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null; }
function upstreamMessage(body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string') return `Qobuz-DL upstream error: ${body.error}`;
  return 'Qobuz-DL upstream request failed';
}

export function isQobuzDlPlanLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /qobuz-dl plan limit|owner has reached their plan limits|plan limits|quota exceeded/i.test(error.message);
}

function isPlanLimitText(text: string): boolean {
  return /owner has reached their plan limits|plan limits|quota exceeded/i.test(text);
}

function isPlanLimitBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return isPlanLimitText(Object.values(body).filter((value) => typeof value === 'string').join(' '));
}

function planLimitMessage(): string {
  return 'Qobuz-DL plan limit reached; source temporarily unavailable';
}
