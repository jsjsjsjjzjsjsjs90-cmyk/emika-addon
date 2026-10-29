import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';

export interface RacingSource { name: string; provider: QobuzProvider }

export class RacingProvider implements QobuzProvider {
  constructor(
    private readonly sources: RacingSource[],
    private readonly perSourceTimeoutMs: number,
  ) {}

  async search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]> {
    const active = this.sources.filter((s) => s.provider);
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
            if (tracks.length > 0) {
              finish(() =>
                resolve(
                  tracks.map((track) => ({
                    ...track,
                    upstreamId: `${source.name}:${track.upstreamId}`,
                  })),
                ),
              );
            }
          })
          .catch((err) => {
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
  instable?: QobuzProvider,
  perSourceTimeoutMs = 3000,
): QobuzProvider {
  const sources: RacingSource[] = [];
  if (qobuzdl)    sources.push({ name: 'qobuzdl',    provider: qobuzdl });
  if (lastbabe)   sources.push({ name: 'lastbabe',   provider: lastbabe });
  if (monochrome) sources.push({ name: 'monochrome', provider: monochrome });
  if (deezer)     sources.push({ name: 'deezer',     provider: deezer });
  if (eljohnzc)   sources.push({ name: 'eljohnzc',   provider: eljohnzc });
  if (instable)   sources.push({ name: 'instable',   provider: instable });
  return new RacingProvider(sources, perSourceTimeoutMs);
}
