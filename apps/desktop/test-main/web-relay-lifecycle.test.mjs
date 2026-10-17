import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebRelayLifecycle } from '../electron/web-relay-lifecycle.cjs';

const login = {
  mode: 'remote',
  url: 'wss://relay.example/ws',
  token: 'test-only-relay-lifecycle-token',
  fingerprint: '',
};
const defaultRoute = '0123456789abcdef0123456789abcdef';
function fixture(options = {}) {
  const started = [];
  const changes = [];
  const relay = createWebRelayLifecycle({
    ...options,
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
        async setRoute(route) {
          this.routes ??= [];
          this.routes.push(route);
          if (this.routeFailure) throw this.routeFailure;
          this.status = {
            state: 'online',
            url: `https://relay.example/remote/${route || 'default'}/`,
            error: null,
            route,
          };
          options.onStatus(this.status);
          return this.status;
        },
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
    route: '',
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

test('relay aliases persist while disabled and do not change the chosen service or listener', async () => {
  const saved = [];
  const { relay, started, changes } = fixture({
    route: 'old-workstation',
    saveRoute: (route) => saved.push(route),
  });
  assert.equal(relay.status.route, 'old-workstation');
  await relay.setRoute('my-pc');
  assert.deepEqual(saved, ['my-pc']);
  assert.equal(relay.status.route, 'my-pc');
  assert.equal(relay.status.enabled, false);
  assert.equal(started.length, 0);
  await relay.enable(login, 5270);
  assert.equal(started[0].options.route, 'my-pc');
  await relay.setRoute('another-pc');
  assert.equal(started.length, 1);
  assert.equal(started[0].closed, 0);
  assert.equal(relay.status.url, 'https://relay.example/remote/another-pc/');
  assert.equal(relay.status.route, 'another-pc');
  assert.deepEqual(saved, ['my-pc', 'another-pc']);
  assert.equal(changes.at(-1).route, 'another-pc');
  await relay.pause();
  await relay.resume(5271);
  assert.equal(started[1].options.route, 'another-pc');
  await relay.disable();
  assert.equal(relay.status.route, 'another-pc');
});

test('the generated route is visible before enabling but stays implicit on the transport', async () => {
  const saved = [];
  const { relay, started, changes } = fixture({
    defaultRoute,
    saveRoute: (route) => saved.push(route),
  });
  assert.equal(relay.status.route, defaultRoute);
  assert.equal(relay.status.enabled, false);
  await relay.setRoute(defaultRoute);
  await relay.setRoute('');
  assert.deepEqual(saved, []);
  assert.equal(started.length, 0);
  await relay.enable(login, 5270);
  assert.equal(started[0].options.route, '');
  await relay.setRoute(defaultRoute);
  assert.equal(started[0].routes, undefined);
  started[0].options.onStatus({ state: 'offline', url: null, error: 'connection lost', route: '' });
  assert.equal(relay.status.route, defaultRoute);
  await relay.disable();
  assert.equal(relay.status.route, defaultRoute);
  assert.ok(changes.every((status) => status.route === defaultRoute));
});

test('custom routes override the default and both clearing and restoring the generated value reset it', async () => {
  const saved = [];
  const { relay, started } = fixture({
    defaultRoute,
    route: 'my-pc',
    saveRoute: (route) => saved.push(route),
  });
  assert.equal(relay.status.route, 'my-pc');
  await relay.setRoute('');
  assert.equal(relay.status.route, defaultRoute);
  await relay.setRoute('other-pc');
  await relay.enable(login, 5270);
  assert.equal(started[0].options.route, 'other-pc');
  await relay.setRoute(defaultRoute);
  assert.equal(relay.status.route, defaultRoute);
  assert.deepEqual(started[0].routes, ['']);
  assert.deepEqual(saved, ['', 'other-pc', '']);
});

test('a stored generated path uses the default transport without a route-update request', async () => {
  const { relay, started } = fixture({ defaultRoute, route: defaultRoute });
  assert.equal(relay.status.route, defaultRoute);
  await relay.enable(login, 5270);
  assert.equal(started[0].options.route, '');
  await relay.setRoute(defaultRoute);
  assert.equal(started[0].routes, undefined);
});

test('failed route updates keep publishing the effective generated default', async () => {
  const { relay, started, changes } = fixture({
    defaultRoute,
    saveRoute: () => {
      throw new Error('disk full');
    },
  });
  await assert.rejects(relay.setRoute('offline-change'), /disk full/);
  assert.equal(relay.status.route, defaultRoute);
  await relay.enable(login, 5270);
  started[0].routeFailure = new Error('unsupported');
  await assert.rejects(relay.setRoute('unsupported-change'), /unsupported/);
  assert.equal(relay.status.route, defaultRoute);
  started[0].routeFailure = undefined;
  await assert.rejects(relay.setRoute('online-change'), /disk full/);
  assert.deepEqual(started[0].routes, ['unsupported-change', 'online-change', '']);
  assert.equal(relay.status.route, defaultRoute);
  assert.ok(changes.every((status) => status.route === defaultRoute));
});

test('relay route validation is strict and unchanged values need no persistence or transport request', async () => {
  const saved = [];
  const { relay, started } = fixture({ saveRoute: (route) => saved.push(route) });
  for (const route of [
    null,
    undefined,
    1,
    {},
    [],
    'UPPER',
    '-pc',
    'pc-',
    'a/b',
    ' a',
    'a ',
    'a\n',
    'a\r\n',
    'a'.repeat(65),
    '电脑',
    '%2f',
  ])
    await assert.rejects(relay.setRoute(route), /访问路径须/);
  assert.equal(started.length, 0);
  assert.deepEqual(saved, []);
  for (const route of ['a', '0', 'my-pc', 'a'.repeat(64), '']) await relay.setRoute(route);
  await relay.setRoute('');
  assert.equal(saved.length, 5);
});

test('route conflicts and unsupported servers preserve the saved path and running connection', async () => {
  const saved = [];
  const { relay, started } = fixture({ route: 'old', saveRoute: (route) => saved.push(route) });
  await relay.enable(login, 5270);
  const controller = started[0];
  await controller.setRoute('old');
  for (const message of ['访问路径已被其他工作台使用', '服务端尚不支持自定义访问路径']) {
    controller.routeFailure = new Error(message);
    await assert.rejects(relay.setRoute('new'), new RegExp(message));
    assert.equal(relay.status.route, 'old');
    assert.equal(relay.status.url, 'https://relay.example/remote/old/');
    assert.equal(controller.closed, 0);
    assert.deepEqual(saved, []);
  }
});

test('a failed preferences write restores the running route before publishing the result', async () => {
  const { relay, started, changes } = fixture({
    route: 'old',
    saveRoute: () => {
      throw new Error('disk full');
    },
  });
  await relay.enable(login, 5270);
  await started[0].setRoute('old');
  const count = changes.length;
  await assert.rejects(relay.setRoute('new'), /disk full/);
  assert.deepEqual(started[0].routes, ['old', 'new', 'old']);
  assert.equal(relay.status.route, 'old');
  assert.equal(relay.status.url, 'https://relay.example/remote/old/');
  assert.equal(started[0].closed, 0);
  assert.ok(
    changes.slice(count).every((status) => status.route === 'old' && status.url.endsWith('/old/')),
  );
  await relay.disable();
  await assert.rejects(relay.setRoute('offline-change'), /disk full/);
  assert.equal(relay.status.route, 'old');
});

test('a lost rollback acknowledgement discards the uncertain transport and resumes the saved path', async () => {
  const { relay, started } = fixture({
    route: 'old',
    saveRoute: () => {
      throw new Error('disk full');
    },
  });
  await relay.enable(login, 5270);
  const first = started[0];
  const setRoute = first.setRoute.bind(first);
  first.setRoute = async (route) => {
    if (route === 'old') throw new Error('transport lost');
    return setRoute(route);
  };
  await assert.rejects(relay.setRoute('new'), /disk full/);
  assert.equal(first.closed, 1);
  assert.equal(started.length, 2);
  assert.equal(started[1].options.route, 'old');
  assert.equal(relay.status.route, 'old');
  assert.equal(relay.status.url, null);
});
