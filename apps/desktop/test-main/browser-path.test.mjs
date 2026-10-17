import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserApi, browserBasePath, browserStorageKey } from '../src/browser-path.ts';

const path = `/remote/${'a'.repeat(32)}/`;
test('local and relay pages use the same API beneath their own entry path', (t) => {
  assert.equal(browserBasePath('/'), '/');
  assert.equal(browserBasePath('/index.html'), '/');
  assert.equal(browserBasePath(`${path}index.html`), path);
  assert.equal(browserBasePath(path.slice(0, -1)), path);
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

test('custom relay routes scope login, control, and browser storage independently', (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'location', before);
    else delete globalThis.location;
  });
  for (const route of ['workstation', 'my-desktop', 'a', 'a'.repeat(64)]) {
    const base = `/remote/${route}/`;
    assert.equal(browserBasePath(base), base);
    assert.equal(browserBasePath(base.slice(0, -1)), base);
    assert.equal(browserBasePath(`${base}index.html`), base);
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { pathname: base },
    });
    assert.equal(browserApi('login'), `${base}api/login`);
    assert.equal(browserApi('control'), `${base}api/control`);
    assert.equal(browserStorageKey('proxy-projects'), `${base}:proxy-projects`);
  }
});

test('noncanonical routes do not become browser API or storage prefixes', () => {
  for (const route of [
    '',
    '../other',
    'UPPER',
    '-start',
    'end-',
    'bad_name',
    'a'.repeat(65),
    'abc\n',
    'abc\r',
    'abc\u2028',
    'abc\u2029',
    'a%2fb',
    'a?b',
    'a#b',
    'a\\b',
  ]) {
    assert.equal(browserBasePath(`/remote/${route}/`), '/', JSON.stringify(route));
  }
  assert.equal(browserBasePath('remote/office/'), '/');
  assert.equal(browserBasePath('/other/office/'), '/');
});
