import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';
const { parseAtmos, parseQuality } = await import('../src/server.js');
const { streamResponse } = await import('../src/normalize.js');

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

test('parseQuality HI_RES preserves 96 kHz and 24-bit stream metadata', () => {
  const quality = parseQuality('hi_res');
  const stream = streamResponse({
    url: 'https://media.example.test/hi-res-96.flac',
    format: 'flac',
    sampleRate: 96_000,
    bitDepth: 24,
  }, quality);

  assert.equal(stream.quality, 'HI_RES');
  assert.equal(stream.sampleRate, 96_000);
  assert.equal(stream.bitDepth, 24);
  assert.equal(stream.codec, 'flac');
});

test('parseQuality HI_RES preserves 192 kHz and 24-bit stream metadata', () => {
  const quality = parseQuality('hi-res');
  const stream = streamResponse({
    url: 'https://media.example.test/hi-res-192.flac',
    format: 'flac',
    sampleRate: 192_000,
    bitDepth: 24,
  }, quality);

  assert.equal(stream.quality, 'HI_RES');
  assert.equal(stream.sampleRate, 192_000);
  assert.equal(stream.bitDepth, 24);
});

test('invalid sample rate and bit depth are not overstated for HI_RES', () => {
  const stream = streamResponse({
    url: 'https://media.example.test/invalid.flac',
    format: 'flac',
    sampleRate: 0,
    bitDepth: 24.5,
  }, parseQuality('hires'));

  assert.equal(stream.quality, 'HI_RES');
  assert.equal(stream.sampleRate, undefined);
  assert.equal(stream.bitDepth, undefined);
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
