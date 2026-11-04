export type Quality = 'HI_RES' | 'LOSSLESS' | 'HIGH' | 'LOW';

export interface QobuzTrack {
  upstreamId: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  isrc?: string;
  artworkURL?: string;
  streamURL?: string;
  format?: string;
  audioQuality?: string;
  availableQualities?: string[];
  audioMode?: string;
  audioModes?: string[];
  atmos?: boolean;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
}

export interface QobuzStream {
  url: string;
  format?: string;
  quality?: string;
  codec?: string;
  container?: string;
  mimeType?: string;
  manifest?: 'none' | 'hls' | 'dash';
  encrypted?: boolean;
  expiresAt?: number;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
  audioMode?: string;
  audioModes?: string[];
  atmos?: boolean;
  streamQuality?: string;
  audioQuality?: string;
}

export interface QobuzProvider {
  search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]>;
  getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null>;
}

export interface PublicTrack extends Omit<QobuzTrack, 'upstreamId'> {
  id: string;
}
