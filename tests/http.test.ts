import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAddress, requestIsSecure } from '../server/http.ts';

test('uses the direct peer unless Cloudflare headers are explicitly trusted', () => {
  assert.equal(requestAddress('127.0.0.1', '203.0.113.9', false), '127.0.0.1');
  assert.equal(requestAddress('127.0.0.1', '203.0.113.9', true), '203.0.113.9');
});

test('rejects malformed Cloudflare client addresses', () => {
  assert.equal(requestAddress('127.0.0.1', 'not-an-ip', true), '127.0.0.1');
  assert.equal(requestAddress(undefined, undefined, true), 'unknown');
});

test('trusts forwarded HTTPS only when the Cloudflare proxy is trusted', () => {
  assert.equal(requestIsSecure(false, 'https', false), false);
  assert.equal(requestIsSecure(false, 'https', true), true);
  assert.equal(requestIsSecure(true, undefined, false), true);
});
