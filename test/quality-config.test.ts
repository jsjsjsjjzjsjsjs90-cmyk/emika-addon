import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDisabledQualityTiers, parseEnabledQualityTiers } from '../src/config.js';

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
