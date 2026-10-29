import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrack, upstreamIdFromPublicId } from '../src/normalize.js';

test('namespaced IDs only verify for the original isolated source', () => {
  const id = normalizeTrack({ upstreamId: '123', title: 'Song' }, 'test-secret', 'qobuzdl').id;
  assert.equal(upstreamIdFromPublicId(id, 'test-secret', 'qobuzdl'), '123');
  assert.equal(upstreamIdFromPublicId(id, 'test-secret', 'instable'), undefined);
  assert.equal(upstreamIdFromPublicId(id, 'test-secret'), 'qobuzdl\u0000123');
});
