import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════
// Interfaces (ต้องอยู่นอก class เท่านั้น)
// ═══════════════════════════════════════════════════════════════

interface InstableErrorInfo {
  retryable: boolean;
  status: number;
  message: string;
}

interface LosslessSignal {
  lossless: boolean;
  format?: string;
}

// ═══════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════

export class InstableProvider implements QobuzProvider {
  constructor(private readonly config: Config) {}

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const body = await this.request('/api/get-music', { q: trimmed });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const items =
      data && isRecord(data.tracks) && Array.isArray(data.tracks.items)
        ? data.tracks.items
        : [];

    return items
      .filter(isRecord)
      .map(toTrack)
      .filter((track): track is QobuzTrack => track !== null);
  }

async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
  // เปลี่ยน Path เป็น api/v2/downloads
  // สมมติว่าพารามิเตอร์ชื่อ id (ต้องเช็คจาก Payload ของคุณว่าใช้คำว่าอะไร)
  const body = await this.request('/api/v2/downloads', { 
      id: trackId, // หรือ track_id ตามที่เว็บเขาใช้
      quality: qualityId(quality) 
  });

  // สมมติว่า Response ส่ง url กลับมาตรงๆ (ต้องเช็คจากแท็บ Response)
  if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) {
    return null;
  }

  return {
    url: body.url,
    format: 'flac',
    quality: quality,
    manifest: 'none',
    encrypted: false,
  };
}

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const base = this.config.instableBaseUrl ?? 'https://instable.arcod.xyz';
    const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let lastError: unknown;
    let lastStatus: number | undefined;

    // 🔧 FIX #7: กัน NaN จาก undefined
    const maxAttempts = Math.max(this.config.upstreamRetries ?? 0, 2);

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();

      // 🔧 FIX #8: กัน NaN จาก undefined
      const timeoutMs = this.config.requestTimeoutMs ?? 6000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            referer: `${base.replace(/\/$/, '')}/`,
            origin: base.replace(/\/$/, ''),
          },
          signal: controller.signal,
        });

        lastStatus = response.status;

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new UpstreamError(502, 'Instable returned invalid JSON');
        }

        if (!response.ok) {
          const error = new UpstreamError(
            retryable(response.status)
              ? 502
              : response.status === 404
                ? 404
                : 400,
            'Instable request failed',
          );
          if (!retryable(response.status) || attempt >= maxAttempts) throw error;
          lastError = error;
        } else if (isRecord(body) && body.success === false) {
          // 🔧 FIX #5: แยก retryable vs permanent จาก body
          const failure = classifyInstableFailure(body);
          throw new UpstreamError(failure.status, failure.message);
        } else {
          return body;
        }
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= maxAttempts) throw error;
          lastError = error;
        } else {
          lastError = error;
        }
      } finally {
        clearTimeout(timeout);
      }

      // 🔧 FIX #10: 429 ต้องรอนานกว่า network error ทั่วไป
      const baseDelay = lastStatus === 429 ? 5000 : 200;
      await delay(baseDelay * 2 ** attempt);
    }

    throw lastError instanceof UpstreamError
      ? lastError
      : new UpstreamError(502, 'Instable request failed');
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers (ทั้งหมดอยู่นอก class)
// ═══════════════════════════════════════════════════════════════

function classifyInstableFailure(body: RecordValue): InstableErrorInfo {
  const rawCode =
    typeof body.code === 'number'
      ? body.code
      : typeof body.statusCode === 'number'
        ? body.statusCode
        : typeof body.status === 'number'
          ? body.status
          : undefined;

  const message =
    typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : 'Instable request failed';

  if (rawCode !== undefined) {
    if (retryable(rawCode)) return { retryable: true, status: 502, message };
    if (rawCode === 404) return { retryable: false, status: 404, message };
    if (rawCode === 401 || rawCode === 403)
      return { retryable: false, status: 401, message };
    return { retryable: false, status: 400, message };
  }

  // ไม่มี code → assume business error → ไม่ retry
  return { retryable: false, status: 400, message };
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;

  if (
    (typeof id !== 'number' && typeof id !== 'string') ||
    typeof title !== 'string' ||
    !title.trim()
  ) {
    return null;
  }

  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const album = isRecord(raw.album) ? raw.album : undefined;
  const image = album && isRecord(album.image) ? album.image : undefined;

  // 🔧 FIX #3: ใช้ detectLossless แทนการเช็ค typeof ตรงๆ
  const { lossless } = detectLossless(raw);

  return {
    upstreamId: String(id),
    title: title.trim(),
    artist: performer && typeof performer.name === 'string' ? performer.name : undefined,
    album: album && typeof album.title === 'string' ? album.title : undefined,
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL: image && typeof image.large === 'string' ? image.large : undefined,
    format: lossless ? 'flac' : undefined,
    audioQuality: lossless ? 'LOSSLESS' : undefined,
  };
}

function detectLossless(raw: RecordValue): LosslessSignal {
  // 1) explicit format string (แม่นสุดถ้ามี)
  if (typeof raw.format === 'string') {
    const fmt = raw.format.toLowerCase().trim();
    if (['flac', 'alac', 'wav', 'aiff', 'dsd'].includes(fmt)) {
      return { lossless: true, format: fmt };
    }
    if (['mp3', 'aac', 'ogg', 'opus', 'm4a', 'wma'].includes(fmt)) {
      return { lossless: false };
    }
  }

  // 2) explicit quality string
  if (typeof raw.quality === 'string') {
    const q = raw.quality.toUpperCase().trim();
    if (['LOSSLESS', 'HI_RES', 'HIRES', 'FLAC'].includes(q)) {
      return { lossless: true, format: 'flac' };
    }
    if (['MP3', 'AAC', 'LOSSY'].includes(q)) {
      return { lossless: false };
    }
  }

  // 3) hires boolean (Qobuz-style)
  if (raw.hires === true) {
    return { lossless: true, format: 'flac' };
  }

  // 4) bit depth threshold — 16-bit คือ CD quality ขั้นต่ำ
  if (typeof raw.maximum_bit_depth === 'number' && raw.maximum_bit_depth >= 16) {
    return { lossless: true, format: 'flac' };
  }

  // 5) ไม่มีหลักฐานชัดเจน → ปลอดภัยที่สุดคือไม่ติดป้าย
  return { lossless: false };
}

function qualityId(quality: Quality): string {
  switch (quality) {
    case 'LOSSLESS':
      return '27';
    case 'HIGH':
    case 'LOW':       // 👈 เพิ่มบรรทัดนี้เข้าไป
      return '5';
    default: {
      const _exhaustive: never = quality;
      throw new Error(`Unknown quality: ${_exhaustive as string}`);
    }
  }
}

function mimeFormat(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const type = value.split('/').pop()?.split(';')[0]?.trim();
  return type || undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
