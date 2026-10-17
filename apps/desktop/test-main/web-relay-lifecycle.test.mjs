import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebRelayLifecycle } from '../electron/web-relay-lifecycle.cjs';

const login = {
  mode: 'remote',
  url: 'wss://relay.example/ws',
  token: 'test-only-relay-lifecycle-token',
  fingerprint: '',
};
function fixture() {
  const started = [];
  const changes = [];
  const relay = createWebRelayLifecycle({
    changed: (status) => changes.push(status),
    start: (options) => {
      const controller = {
        options,
        closed: 0,
        status: { state: 'connecting', url: null, error: null },
        close() {
          this.closed++;
        },
        context: (request) => ({ request, port: options.port }),
      };
      started.push(controller);
      return controller;
    },
  });
  return { relay, started, changes };
}

test('relay starts disabled, takes a private login snapshot and exposes no credentials', async () => {
  const { relay, started } = fixture();
  assert.deepEqual(relay.status, {
    enabled: false,
    state: 'disabled',
    url: null,
    error: null,
  });
  assert.equal(relay.context({}), null);
  assert.equal(started.length, 0);
  const configuration = { ...login };
  await relay.enable(configuration, 17890);
  configuration.token = 'replacement';
  configuration.url = 'wss://different.example/ws';
  await relay.enable(configuration, 17891);
  assert.equal(started.length, 1);
  assert.equal(started[0].options.config.token, login.token);
  assert.equal(started[0].options.config.url, login.url);
  assert.equal(started[0].options.port, 17890);
  assert.ok(!JSON.stringify(relay.status).includes(login.token));
});

test('relay rejects absent credentials and local simulation without opening a connection', async () => {
  const { relay, started } = fixture();
  for (const input of [null, { ...login, mode: 'local' }, { ...login, token: '' }])
    await assert.rejects(relay.enable(input, 17890), /服务地址和凭据/);
  assert.equal(started.length, 0);
  assert.equal(relay.status.enabled, false);
});

test('Web listener rebind preserves the chosen service and ignores stale transport events', async () => {
  const { relay, started } = fixture();
  await relay.enable(login, 17890);
  const first = started[0];
  first.options.onStatus({ state: 'online', url: 'https://relay.example/remote/id/', error: null });
  assert.equal(relay.status.state, 'online');
  await relay.pause();
  assert.equal(first.closed, 1);
  assert.equal(relay.context({}), null);
  assert.equal(relay.status.url, null);
  await relay.resume(17891);
  assert.equal(started[1].options.port, 17891);
  assert.deepEqual(started[1].options.config, first.options.config);
  started[1].options.onStatus({
    state: 'online',
    url: 'https://relay.example/remote/id/',
    error: null,
  });
  assert.equal(relay.status.url, 'https://relay.example/remote/id/');
  first.options.onStatus({ state: 'offline', url: null, error: 'old connection' });
  assert.equal(relay.status.state, 'online');
  assert.equal(relay.status.error, null);
  await relay.disable();
  assert.equal(started[1].closed, 1);
  started[1].options.onStatus({ state: 'online', url: 'https://relay.example/', error: null });
  assert.equal(relay.status.enabled, false);
  await relay.resume(17892);
  assert.equal(started.length, 2);
});

test('disable closes a late start result without restoring access', async () => {
  let finish;
  let closed = 0;
  const relay = createWebRelayLifecycle({
    start: () => new Promise((resolve) => (finish = resolve)),
  });
  const enabling = relay.enable(login, 17890);
  await new Promise(setImmediate);
  await relay.disable();
  finish({ close: () => closed++, status: { state: 'online', url: 'https://relay.example/' } });
  await enabling;
  assert.equal(closed, 1);
  assert.equal(relay.status.enabled, false);
  assert.equal(relay.status.url, null);
});

test('quit during the initial detach leaves relay disabled without dialing', async () => {
  const { relay, started } = fixture();
  const enabling = relay.enable(login, 17890);
  await relay.disable();
  await enabling;
  assert.equal(started.length, 0);
  assert.equal(relay.status.enabled, false);
  assert.equal(relay.status.state, 'disabled');
});

test('startup failure is reported independently and disabling allows a new service choice', async () => {
  const relay = createWebRelayLifecycle({
    start: () => {
      throw new Error('Rejected endpoint');
    },
  });
  const status = await relay.enable(login, 17890);
  assert.equal(status.enabled, true);
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'Rejected endpoint');
  await relay.disable();
  assert.equal(relay.status.state, 'disabled');
});
