import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { isQobuzDlPlanLimitError } from './qobuzdl.js';

export interface RacingSource { name: string; provider: QobuzProvider }

export class RacingProvider implements QobuzProvider {
  constructor(
    private readonly sources: RacingSource[],
    private readonly perSourceTimeoutMs: number,
    private readonly qobuzdlPlanLimitCooldownMs = 60_000,
  ) {
    this.qobuzdlUnavailableUntil = 0;
  }

  private qobuzdlUnavailableUntil: number;

  async search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]> {
    const now = Date.now();
    const active = this.sources.filter((s) => s.provider && (s.name !== 'qobuzdl' || now >= this.qobuzdlUnavailableUntil));
    if (active.length === 0) return [];

    return new Promise<QobuzTrack[]>((resolve, reject) => {
      let pending = active.length;
      let rejected = 0;
      let lastError: unknown;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      for (const source of active) {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeout = new Promise<QobuzTrack[]>((_, rej) => {
          timeoutHandle = setTimeout(() => rej(new Error(`source ${source.name} timed out`)), this.perSourceTimeoutMs);
        });

        Promise.race([source.provider.search(query, quality, atmos), timeout])
          .then((tracks) => {
            if (settled) return;
            const usableTracks = tracks.filter((track) => track.upstreamId.trim() && track.title.trim());
            if (usableTracks.length > 0) {
              finish(() =>
                resolve(
                  usableTracks.map((track) => ({
                    ...track,
                    upstreamId: `${source.name}:${track.upstreamId}`,
                  })),
                ),
              );
            }
          })
          .catch((err) => {
            if (source.name === 'qobuzdl' && isQobuzDlPlanLimitError(err)) {
              this.qobuzdlUnavailableUntil = Date.now() + this.qobuzdlPlanLimitCooldownMs;
            }
            rejected += 1;
            lastError = err;
          })
          .finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            pending -= 1;
            if (pending === 0 && !settled) {
              if (rejected === active.length) finish(() => reject(lastError));
              else finish(() => resolve([]));
            }
          });
      }
    });
  }

  async getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null> {
    const sep = trackId.indexOf(':');
    if (sep <= 0) return null;
    const sourceName = trackId.slice(0, sep);
    const upstreamId = trackId.slice(sep + 1);
    if (sourceName === 'qobuzdl' && Date.now() < this.qobuzdlUnavailableUntil) return null;
    const source = this.sources.find((c) => c.name === sourceName);
    return source ? source.provider.getStream(upstreamId, quality, atmos) : null;
  }
}

export function createRacingProvider(
  qobuzdl?: QobuzProvider,
  lastbabe?: QobuzProvider,
  monochrome?: QobuzProvider,
  deezer?: QobuzProvider,
  eljohnzc?: QobuzProvider,
  bitchordhires?: QobuzProvider,
  instable?: QobuzProvider,
  perSourceTimeoutMs = 3000,
  qobuzdlPlanLimitCooldownMs = 60_000,
): QobuzProvider {
  const sources: RacingSource[] = [];
  if (qobuzdl)    sources.push({ name: 'qobuzdl',    provider: qobuzdl });
  if (lastbabe)   sources.push({ name: 'lastbabe',   provider: lastbabe });
  if (monochrome) sources.push({ name: 'monochrome', provider: monochrome });
  if (deezer)     sources.push({ name: 'deezer',     provider: deezer });
  if (eljohnzc)   sources.push({ name: 'eljohnzc',   provider: eljohnzc });
  if (bitchordhires) sources.push({ name: 'bitchordhires', provider: bitchordhires });
  if (instable)   sources.push({ name: 'instable',   provider: instable });
  return new RacingProvider(sources, perSourceTimeoutMs, qobuzdlPlanLimitCooldownMs);
}
