import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostCapabilities, takePairingCode } from '../src/host-capabilities.ts';

test('a browser controls sessions but has no local executor or desktop management capabilities', () => {
  assert.deepEqual(hostCapabilities('browser'), {
    localProjects: false,
    schedules: false,
    accountManagement: false,
    serviceManagement: false,
    nativeSettings: false,
  });
  assert.ok(Object.values(hostCapabilities('desktop')).every(Boolean));
});

test('pairing consumes a fragment before any network access without changing the route', () => {
  const calls = [];
  const state = { selected: 'kept' };
  const history = { state, replaceState: (...args) => calls.push(args) };
  assert.equal(
    takePairingCode(
      { pathname: '/web/', search: '?view=chat', hash: '#pair=a%2Bb&tab=1' },
      history,
    ),
    'a+b',
  );
  assert.deepEqual(calls, [[state, '', '/web/?view=chat#tab=1']]);
});

test('a normal navigation preserves its fragment and does not fabricate a code', () => {
  assert.equal(
    takePairingCode(
      { pathname: '/web/', search: '', hash: '#messages' },
      {
        state: null,
        replaceState: () => assert.fail('ordinary history must remain untouched'),
      },
    ),
    '',
  );
});

test('an empty pairing fragment is removed too', () => {
  let url;
  assert.equal(
    takePairingCode(
      { pathname: '/web/', search: '', hash: '#pair=' },
      {
        state: null,
        replaceState: (_state, _unused, next) => {
          url = next;
        },
      },
    ),
    '',
  );
  assert.equal(url, '/web/');
});
