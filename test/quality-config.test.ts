import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseDisabledQualityTiers, parseEnabledQualityTiers, parseZeroOneFlag } from '../src/config.js';

test('quality tiers stay enabled when the disable env is empty', () => {
  assert.deepEqual([...parseEnabledQualityTiers('')], ['HI_RES', 'LOSSLESS', 'HIGH', 'LOW']);
});

test('quality disable env accepts aliases and ignores unknown values', () => {
  assert.deepEqual(
    [...parseDisabledQualityTiers(' high, hi-res, atmos, not-a-tier ')].sort(),
    ['HI_RES', 'LOSSLESS', 'HIGH'].sort(),
  );
  assert.deepEqual([...parseEnabledQualityTiers('high,hi-res')], ['LOSSLESS', 'LOW']);
});

test('disabling every tier keeps LOSSLESS as a safe fallback', () => {
  assert.deepEqual([...parseEnabledQualityTiers('hi_res,lossless,high,low')], ['LOSSLESS']);
});

test('UPSTREAM_RETRIES=0 disables retries instead of falling back to one', () => {
  const previous = process.env.UPSTREAM_RETRIES;
  process.env.UPSTREAM_RETRIES = '0';
  try {
    assert.equal(loadConfig().upstreamRetries, 0);
  } finally {
    if (previous === undefined) delete process.env.UPSTREAM_RETRIES;
    else process.env.UPSTREAM_RETRIES = previous;
  }
});

test('checkValidLossless flag accepts only 0 and 1', () => {
  assert.equal(parseZeroOneFlag('0'), false);
  assert.equal(parseZeroOneFlag('1'), true);
  assert.equal(parseZeroOneFlag(' true'), false);
  assert.equal(parseZeroOneFlag('invalid', true), true);
});

test('EMIKA_CHECK_VALID_LOSSLESS controls config with 0 and 1', () => {
  const previous = process.env.EMIKA_CHECK_VALID_LOSSLESS;
  try {
    process.env.EMIKA_CHECK_VALID_LOSSLESS = '1';
    assert.equal(loadConfig().checkValidLossless, true);
    process.env.EMIKA_CHECK_VALID_LOSSLESS = '0';
    assert.equal(loadConfig().checkValidLossless, false);
  } finally {
    if (previous === undefined) delete process.env.EMIKA_CHECK_VALID_LOSSLESS;
    else process.env.EMIKA_CHECK_VALID_LOSSLESS = previous;
  }
});

test('User-Agent settings are configurable and safe by default', () => {
  const previousRequired = process.env.EMIKA_REQUIRE_BITCHORD_USER_AGENT;
  const previousUserAgent = process.env.EMIKA_USER_AGENT;
  try {
    delete process.env.EMIKA_REQUIRE_BITCHORD_USER_AGENT;
    delete process.env.EMIKA_USER_AGENT;
    assert.equal(loadConfig().requireBitChordUserAgent, false);
    assert.equal(loadConfig().userAgent, 'BitChord/v1.9');
    process.env.EMIKA_REQUIRE_BITCHORD_USER_AGENT = '1';
    process.env.EMIKA_USER_AGENT = 'Emika/2.0';
    assert.equal(loadConfig().requireBitChordUserAgent, true);
    assert.equal(loadConfig().userAgent, 'Emika/2.0');
  } finally {
    if (previousRequired === undefined) delete process.env.EMIKA_REQUIRE_BITCHORD_USER_AGENT;
    else process.env.EMIKA_REQUIRE_BITCHORD_USER_AGENT = previousRequired;
    if (previousUserAgent === undefined) delete process.env.EMIKA_USER_AGENT;
    else process.env.EMIKA_USER_AGENT = previousUserAgent;
  }
});

test('Signed UI Session settings are disabled by default and configurable', () => {
  const previousEnabled = process.env.EMIKA_ALLOW_SIGNED_UI_SESSION;
  const previousTtl = process.env.EMIKA_UI_SESSION_TTL_SECONDS;
  try {
    delete process.env.EMIKA_ALLOW_SIGNED_UI_SESSION;
    delete process.env.EMIKA_UI_SESSION_TTL_SECONDS;
    assert.equal(loadConfig().allowSignedUiSession, false);
    assert.equal(loadConfig().uiSessionTtlSeconds, 3600);
    process.env.EMIKA_ALLOW_SIGNED_UI_SESSION = '1';
    process.env.EMIKA_UI_SESSION_TTL_SECONDS = '900';
    assert.equal(loadConfig().allowSignedUiSession, true);
    assert.equal(loadConfig().uiSessionTtlSeconds, 900);
  } finally {
    if (previousEnabled === undefined) delete process.env.EMIKA_ALLOW_SIGNED_UI_SESSION;
    else process.env.EMIKA_ALLOW_SIGNED_UI_SESSION = previousEnabled;
    if (previousTtl === undefined) delete process.env.EMIKA_UI_SESSION_TTL_SECONDS;
    else process.env.EMIKA_UI_SESSION_TTL_SECONDS = previousTtl;
  }
});

test('stream routing defaults to proxy and enables native direct modes independently', () => {
  const previous = {
    proxy: process.env.EMIKA_PROXY_WEB_MEDIA,
    bitChord: process.env.EMIKA_DIRECT_STREAM_BITCHORD,
    lastWave: process.env.EMIKA_DIRECT_STREAM_LASTWAVE,
  };
  try {
    delete process.env.EMIKA_PROXY_WEB_MEDIA;
    delete process.env.EMIKA_DIRECT_STREAM_BITCHORD;
    delete process.env.EMIKA_DIRECT_STREAM_LASTWAVE;
    let config = loadConfig();
    assert.equal(config.proxyWebMedia, true);
    assert.equal(config.directStreamBitChord, true);
    assert.equal(config.directStreamLastWave, true);

    process.env.EMIKA_PROXY_WEB_MEDIA = '0';
    process.env.EMIKA_DIRECT_STREAM_BITCHORD = '1';
    process.env.EMIKA_DIRECT_STREAM_LASTWAVE = '1';
    config = loadConfig();
    assert.equal(config.proxyWebMedia, false);
    assert.equal(config.directStreamBitChord, true);
    assert.equal(config.directStreamLastWave, true);
  } finally {
    for (const [key, value] of Object.entries({
      EMIKA_PROXY_WEB_MEDIA: previous.proxy,
      EMIKA_DIRECT_STREAM_BITCHORD: previous.bitChord,
      EMIKA_DIRECT_STREAM_LASTWAVE: previous.lastWave,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('separates root source policy from optional isolated sources', () => {
  const previousEnabled = process.env.QOBUZ_ENABLED_SOURCES;
  const previousRoot = process.env.EMIKA_ROOT_SOURCES;
  try {
    process.env.QOBUZ_ENABLED_SOURCES = 'instable,eljohnzc,bitchordhires';
    process.env.EMIKA_ROOT_SOURCES = 'instable';
    const config = loadConfig();
    assert.deepEqual([...config.enabledSources], ['instable', 'eljohnzc', 'bitchordhires']);
    assert.deepEqual([...config.rootEnabledSources ?? []], ['instable']);
    assert.equal(config.eljohnzcBaseUrl, 'https://eljohnzc-addon.de.deplexo.com/59efe06a96');
    assert.equal(config.bitchordHiresBaseUrl, 'https://bitchord-hires-addon.de.deplexo.com');
  } finally {
    if (previousEnabled === undefined) delete process.env.QOBUZ_ENABLED_SOURCES;
    else process.env.QOBUZ_ENABLED_SOURCES = previousEnabled;
    if (previousRoot === undefined) delete process.env.EMIKA_ROOT_SOURCES;
    else process.env.EMIKA_ROOT_SOURCES = previousRoot;
  }
});
