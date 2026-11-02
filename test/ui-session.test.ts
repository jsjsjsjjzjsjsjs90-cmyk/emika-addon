import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiSession, readCookie, UI_SESSION_COOKIE, verifyUiSession } from '../src/ui-session.js';

test('signed UI session verifies before expiry and rejects tampering', () => {
  const now = 1_700_000_000_000;
  const token = createUiSession('test-secret', 3600, now);
  assert.equal(verifyUiSession(token, 'test-secret', now + 3599_000), true);
  assert.equal(verifyUiSession(token, 'wrong-secret', now), false);
  assert.equal(verifyUiSession(`${token}x`, 'test-secret', now), false);
});

test('signed UI session expires at its configured TTL', () => {
  const now = 1_700_000_000_000;
  const token = createUiSession('test-secret', 60, now);
  assert.equal(verifyUiSession(token, 'test-secret', now + 60_000), true);
  assert.equal(verifyUiSession(token, 'test-secret', now + 61_000), false);
});

test('cookie parser reads the signed UI session without trusting other cookies', () => {
  const token = createUiSession('test-secret', 60, 1_700_000_000_000);
  const header = `theme=dark; ${UI_SESSION_COOKIE}=${token}; other=value`;
  assert.equal(readCookie(header, UI_SESSION_COOKIE), token);
  assert.equal(readCookie(header, 'missing'), undefined);
});
