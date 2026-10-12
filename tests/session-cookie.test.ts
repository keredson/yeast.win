import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSessionCookie, readSessionCookie, sessionCookie, sessionCookieName } from '../server/auth.ts';

test('sessions on different API ports keep separate cookies', () => {
  const first = sessionCookieName(3001);
  const second = sessionCookieName(3002);
  const header = `${first}=first-token; ${second}=second-token; brewlog_session=old-token`;

  assert.notEqual(first, second);
  assert.equal(readSessionCookie(header, first), 'first-token');
  assert.equal(readSessionCookie(header, second), 'second-token');
  assert.equal(readSessionCookie(header, sessionCookieName(30010)), undefined);
  assert.match(sessionCookie('new-token', false, second), /^brewlog_session_3002=new-token;/);
  assert.match(clearSessionCookie(false, second), /^brewlog_session_3002=;.*Max-Age=0/);
});
