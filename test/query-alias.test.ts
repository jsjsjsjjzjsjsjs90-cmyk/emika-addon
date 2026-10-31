import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';
const { parseAtmos, parseQuality } = await import('../src/server.js');

test('parseQuality accepts LastWave hi_res aliases as a distinct HI_RES tier', () => {
  for (const value of ['hi_res', 'HI_RES', 'hi-res', 'hi res', 'hires', 'hi_res_lossless', 'hi-res-lossless']) {
    assert.equal(parseQuality(value), 'HI_RES', value);
  }
});

test('parseQuality keeps native tiers and defaults safely', () => {
  assert.equal(parseQuality(undefined), 'LOSSLESS');
  assert.equal(parseQuality(' lossless '), 'LOSSLESS');
  assert.equal(parseQuality('high'), 'HIGH');
  assert.equal(parseQuality('low'), 'LOW');
});

test('parseQuality rejects unknown values', () => {
  assert.throws(() => parseQuality('ultra'), /quality must be HI_RES, LOSSLESS, HIGH, or LOW/);
});

test('parseQuality trims aliases and does not conflate Hi-Res with Lossless', () => {
  assert.equal(parseQuality('  Hi_Res  '), 'HI_RES');
  assert.notEqual(parseQuality('hires'), parseQuality('lossless'));
});

test('parseAtmos maps LastWave none aliases to off', () => {
  for (const value of ['none', 'NONE', 'disabled', 'disable', 'false', '0']) {
    assert.equal(parseAtmos(value), 'off', value);
  }
});

test('parseAtmos accepts native values and defaults safely', () => {
  assert.equal(parseAtmos(undefined), 'auto');
  assert.equal(parseAtmos(' AUTO '), 'auto');
  assert.equal(parseAtmos('on'), 'on');
  assert.equal(parseAtmos('off'), 'off');
});

test('parseAtmos rejects unknown values', () => {
  assert.throws(() => parseAtmos('maybe'), /atmos must be auto, on, or off/);
});
