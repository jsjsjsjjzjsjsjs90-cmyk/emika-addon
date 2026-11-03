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
  | 'deezer' | 'eljohnzc' | 'bitchordhires' | 'instable';

function buildFor(config: Config, source: IsolatedSource): QobuzProvider | undefined {
  if (!config.enabledSources.has(source)) return undefined;

  switch (source) {
    case 'qobuzdl':    return new QobuzDlProvider(config);
    case 'lastbabe':   return new LastBabeProvider(config);
    case 'monochrome': return new MonochromeProvider(config);
    case 'deezer':     return new RemoteAddonProvider(config);
    case 'eljohnzc':   return new RemoteAddonProvider(config, config.eljohnzcBaseUrl);
    case 'bitchordhires': return new RemoteAddonProvider(config, config.bitchordHiresBaseUrl);
    case 'instable':   return new InstableProvider(config);
  }
}

export function createProvider(config: Config): QobuzProvider {
  const rootConfig = config.rootEnabledSources
    ? { ...config, enabledSources: config.rootEnabledSources }
    : config;
  if (rootConfig.provider === 'qobuzdl') return new QobuzDlProvider(rootConfig);
  if (rootConfig.provider === 'http')    return new HttpQobuzProvider(rootConfig);
  if (rootConfig.provider === 'multi') {
    return createRacingProvider(
      buildFor(rootConfig, 'qobuzdl'),
      buildFor(rootConfig, 'lastbabe'),
      buildFor(rootConfig, 'monochrome'),
      buildFor(rootConfig, 'deezer'),
      buildFor(rootConfig, 'eljohnzc'),
      buildFor(rootConfig, 'bitchordhires'),
      buildFor(rootConfig, 'instable'),
      rootConfig.sourceSearchTimeoutMs,
      rootConfig.qobuzdlPlanLimitCooldownMs,
    );
  }
  return new StubQobuzProvider();
}

export function createSourceProvider(config: Config, source: IsolatedSource): QobuzProvider {
  return buildFor(config, source) ?? new StubQobuzProvider();
}
