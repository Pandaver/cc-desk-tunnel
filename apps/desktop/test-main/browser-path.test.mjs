import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserApi, browserBasePath, browserStorageKey } from '../src/browser-path.ts';

const path = `/remote/${'a'.repeat(32)}/`;
test('local and relay pages use the same API beneath their own entry path', (t) => {
  assert.equal(browserBasePath('/'), '/');
  assert.equal(browserBasePath('/index.html'), '/');
  assert.equal(browserBasePath('/remote/not-a-device/'), '/');
  assert.equal(browserBasePath(`${path}index.html`), path);
  assert.equal(browserBasePath(path.slice(0, -1)), path);
  assert.equal(browserBasePath(`/remote/${'a'.repeat(33)}/`), '/');
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'location', before);
    else delete globalThis.location;
  });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: path } });
  assert.equal(browserApi('login'), `${path}api/login`);
  assert.equal(browserApi('control'), `${path}api/control`);
  assert.equal(browserStorageKey('proxy-projects'), `${path}:proxy-projects`);
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/' } });
  assert.equal(browserApi('logout'), '/api/logout');
  assert.equal(browserStorageKey('proxy-prefs'), 'proxy-prefs');
});
