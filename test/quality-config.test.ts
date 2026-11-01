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
