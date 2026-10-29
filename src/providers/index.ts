import type { Config } from '../config.js';
import type { QobuzProvider } from '../types.js';
import { StubQobuzProvider } from './stub.js';
import { HttpQobuzProvider } from './http.js';
import { QobuzDlProvider } from './qobuzdl.js';
import { LastBabeProvider } from './lastbabe.js';
import { createRacingProvider } from './racing.js';
import { MonochromeProvider } from './monochrome.js';
import { RemoteAddonProvider } from './remote-addon.js';
import { InstableProvider } from './instable.js';

export type IsolatedSource =
  | 'qobuzdl' | 'lastbabe' | 'monochrome'
  | 'deezer' | 'eljohnzc' | 'instable';

function buildFor(config: Config, source: IsolatedSource): QobuzProvider | undefined {
  if (source === 'eljohnzc') return undefined; // no implementation yet — do not wire it in
  if (!config.enabledSources.has(source)) return undefined;

  switch (source) {
    case 'qobuzdl':    return new QobuzDlProvider(config);
    case 'lastbabe':   return new LastBabeProvider(config);
    case 'monochrome': return new MonochromeProvider(config);
    case 'deezer':     return new RemoteAddonProvider(config);
    case 'instable':   return new InstableProvider(config);
  }
}

export function createProvider(config: Config): QobuzProvider {
  if (config.provider === 'qobuzdl') return new QobuzDlProvider(config);
  if (config.provider === 'http')    return new HttpQobuzProvider(config);
  if (config.provider === 'multi') {
    return createRacingProvider(
      buildFor(config, 'qobuzdl'),
      buildFor(config, 'lastbabe'),
      buildFor(config, 'monochrome'),
      buildFor(config, 'deezer'),
      undefined,
      buildFor(config, 'instable'),
      config.sourceSearchTimeoutMs,
    );
  }
  return new StubQobuzProvider();
}

export function createSourceProvider(config: Config, source: IsolatedSource): QobuzProvider {
  return buildFor(config, source) ?? new StubQobuzProvider();
}
