import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter, clientKey } from '../src/rate-limit.js';
import { TtlCache } from '../src/cache.js';

test('rate limiter blocks after the configured window quota', () => {
  const limiter = new SlidingWindowRateLimiter(2, 1000);
  assert.equal(limiter.check('client', 0).allowed, true);
  assert.equal(limiter.check('client', 1).allowed, true);
  const blocked = limiter.check('client', 2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(limiter.check('client', 1001).allowed, true);
});

test('rate limiter bounds the number of tracked clients', () => {
  const limiter = new SlidingWindowRateLimiter(1, 1000, 2);
  limiter.check('a', 0);
  limiter.check('b', 0);
  limiter.check('c', 0);
  assert.equal(limiter.check('c', 1).allowed, false);
  assert.equal(limiter.check('a', 1).allowed, true);
});

test('client key prefers the first trusted forwarded address', () => {
  assert.equal(clientKey('10.0.0.1', '203.0.113.5, 10.0.0.1'), '203.0.113.5');
  assert.equal(clientKey('10.0.0.1'), '10.0.0.1');
});

test('cache deduplicates concurrent loaders', async () => {
  const cache = new TtlCache<string>(1000);
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'value';
  };
  const values = await Promise.all([
    cache.getOrLoad('key', loader),
    cache.getOrLoad('key', loader),
    cache.getOrLoad('key', loader),
  ]);
  assert.deepEqual(values, ['value', 'value', 'value']);
  assert.equal(calls, 1);
});
