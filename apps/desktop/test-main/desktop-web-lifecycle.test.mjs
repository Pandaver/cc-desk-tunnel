import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const filename = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
const require = createRequire(filename);
const source = readFileSync(filename, 'utf8');
const config = { url: 'wss://service.example/ws', fingerprint: '', token: 'short' };
const nextTurn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Execute the production handlers with in-memory host dependencies. The loader substitution avoids
// experimental VM module flags; no Electron window, socket, subprocess or user profile is opened.
function fixture(initialFiles) {
  const handlers = new Map();
  const events = new Map();
  const files = new Map(initialFiles);
  const imported = [];
  const order = [];
  const bridges = [];
  const listeners = [];
  const relays = [];
  const opened = [];
  const awake = new Set();
  const messages = [];
  const marks = [];
  let openGate;
  let listenerFailure;
  let quits = 0;
  const profile = join(dirname(filename), 'memory-profile');
  const sender = { isDestroyed: () => false, send: (...args) => messages.push(args) };
  const electron = {
    app: {
      getPath: () => profile,
      requestSingleInstanceLock: () => true,
      isPackaged: false,
      whenReady: () => new Promise(() => {}),
      setAppUserModelId() {},
      getVersion: () => '0.3.2',
      on: (name, listener) => events.set(name, listener),
      quit: () => quits++,
    },
    ipcMain: {
      handle: (name, listener) => handlers.set(name, listener),
      on() {},
    },
    BrowserWindow: { getAllWindows: () => [{ webContents: sender }] },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async (url) => opened.push(url) },
    session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
    powerSaveBlocker: {
      start: () => {
        const id = Symbol();
        awake.add(id);
        return id;
      },
      stop: (id) => awake.delete(id),
    },
  };
  const mockRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === 'node:fs')
      return {
        existsSync: (path) => files.has(path),
        readFileSync: (path) => {
          if (!files.has(path)) throw new Error('ENOENT');
          return files.get(path);
        },
        writeFileSync: (path, text) => files.set(path, text),
      };
    if (name === './connections.cjs')
      return {
        requested: () => '',
        list: () => [{ id: '', name: '主连接' }],
        busy: () => [],
        readShared: () => undefined,
        mark: (...args) => marks.push(args),
      };
    if (name === './client-log.cjs') return { openLog: () => ({ write() {} }) };
    if (name === './web-auth.cjs')
      return {
        atomicPrivateWrite: (path, text) => files.set(path, text),
        createWebAuthStore: () => ({ token: 'pairing-code', list: () => [], subscribe() {} }),
      };
    if (name === './git-branch.cjs') return { gitBranch: async () => null };
    if (name === './disk-path.cjs') return { asOnDisk: async (path) => path };
    if (name === './web-relay-lifecycle.cjs') return require(name);
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  const load = async (name) => {
    imported.push(name);
    if (name.endsWith('proxy-bridge.mjs'))
      return {
        openProxyBridge: async (configuration, options, onClosed) => {
          const gate = openGate;
          openGate = undefined;
          const bridge = {
            config: configuration,
            options,
            onClosed,
            url: `ws://127.0.0.1/bridge-${bridges.length}`,
            closed: 0,
            closeGate: undefined,
            async close() {
              order.push('bridge:close');
              bridge.closed++;
              await bridge.closeGate?.promise;
            },
          };
          order.push('bridge:open');
          bridges.push(bridge);
          await gate?.promise;
          return bridge;
        },
      };
    if (name === './desktop-web.mjs')
      return {
        startWebRelay(options) {
          const relay = {
            options,
            closed: 0,
            status: { state: 'connecting', url: null, error: null },
            async close() {
              relay.closed++;
            },
            context: () => ({ origin: 'https://relay.example', basePath: '/remote/test/' }),
          };
          relays.push(relay);
          return relay;
        },
        async startWebServer(options) {
          if (listenerFailure) {
            const error = listenerFailure;
            listenerFailure = undefined;
            throw error;
          }
          const listener = {
            options,
            port: options.port,
            closed: 0,
            async close() {
              listener.closed++;
            },
          };
          listeners.push(listener);
          return listener;
        },
        createWebControl() {
          throw new Error('No browser has attached in this lifecycle test');
        },
      };
    throw new Error(`Unexpected import: ${name}`);
  };
  const execute = new Script(
    `(function(require, __dirname, __import, process) {\n${source.replace(/\bimport\(/g, '__import(')}\n})`,
    { filename },
  ).runInThisContext();
  execute(mockRequire, dirname(filename), load, { ...process, argv: [] });
  const event = { senderFrame: { url: 'file:///desktop/index.html' }, sender };
  return {
    call: (name, ...args) => handlers.get(name)(event, ...args),
    emit: (name, ...args) => events.get(name)(...args),
    imported,
    order,
    bridges,
    listeners,
    relays,
    opened,
    files,
    awake,
    messages,
    marks,
    quits: () => quits,
    holdOpen: (gate) => (openGate = gate),
    failListener: () => (listenerFailure = new Error('EADDRINUSE')),
  };
}

test('Web disabled keeps the original bridge endpoint and reconnects even for the same configuration', async () => {
  const host = fixture();
  const first = await host.call('proxy:connect', config);
  assert.equal(first.url, host.bridges[0].url);
  assert.equal(host.bridges[0].config.token, 'short');
  const second = await host.call('proxy:connect', { ...config });
  assert.equal(second.url, host.bridges[1].url);
  assert.deepEqual(host.order, ['bridge:open', 'bridge:close', 'bridge:open']);
  assert.equal(host.bridges[0].closed, 1);
  assert.equal(host.bridges[1].closed, 0);
  assert.equal(host.listeners.length, 0);
  assert.ok(host.imported.every((name) => name.endsWith('proxy-bridge.mjs')));
  await host.call('proxy:disconnect');
  assert.equal(host.bridges[1].closed, 1);
  assert.equal(host.awake.size, 0);
});

test('enabling, changing the port and disabling Web never replace or close the desktop bridge', async () => {
  const host = fixture();
  await host.call('proxy:connect', config);
  await host.call('remote:configure', { enabled: true, port: 17890 });
  await host.call('remote:configure', { enabled: true, port: 17891 });
  assert.equal(host.listeners[0].closed, 1);
  assert.equal(host.listeners[1].closed, 0);
  host.failListener();
  await assert.rejects(host.call('remote:configure', { enabled: true, port: 17892 }), /EADDRINUSE/);
  assert.equal(host.call('remote:status').port, 17891);
  assert.equal(host.listeners[1].closed, 0);
  await host.call('remote:configure', { enabled: false });
  assert.equal(host.listeners[1].closed, 1);
  assert.equal(host.bridges.length, 1);
  assert.equal(host.bridges[0].closed, 0);
  assert.equal(host.awake.size, 1);
  assert.deepEqual(
    host.messages.filter(([name]) => name === 'remote:enabled-changed'),
    [
      ['remote:enabled-changed', true],
      ['remote:enabled-changed', false],
    ],
  );
});

test('disconnect still cancels an in-flight bridge and closes its late result', async () => {
  const host = fixture();
  const gate = deferred();
  host.holdOpen(gate);
  const connecting = host.call('proxy:connect', config);
  const cancelled = assert.rejects(connecting, /Connection cancelled/);
  await nextTurn();
  assert.equal(host.bridges.length, 1);
  await host.call('proxy:disconnect');
  gate.resolve();
  await cancelled;
  assert.equal(host.bridges[0].closed, 1);
  assert.equal(host.awake.size, 0);
});

test('a stale bridge close callback cannot disconnect the replacement bridge', async () => {
  const host = fixture();
  await host.call('proxy:connect', config);
  await host.call('proxy:connect', config);
  host.bridges[0].onClosed();
  assert.equal(host.awake.size, 1);
  assert.deepEqual(host.messages, []);
  host.bridges[1].onClosed();
  assert.equal(host.awake.size, 0);
  assert.deepEqual(host.messages, [['proxy:closed']]);
});

test('quit waits for the original bridge close, then closes the optional Web listener on exit', async () => {
  const host = fixture();
  await host.call('proxy:connect', config);
  await host.call('remote:configure', { enabled: true });
  const gate = deferred();
  host.bridges[0].closeGate = gate;
  let prevented = false;
  host.emit('before-quit', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(host.bridges[0].closed, 1);
  assert.equal(host.quits(), 0);
  gate.resolve();
  await nextTurn();
  assert.equal(host.quits(), 1);
  host.emit('quit');
  assert.equal(host.listeners[0].closed, 1);
  assert.equal(host.marks.at(-1)[2], false);
});

test('without a bridge, quit is not delayed by the optional Web listener', async () => {
  const host = fixture();
  await host.call('remote:configure', { enabled: true });
  let prevented = false;
  host.emit('before-quit', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
  host.emit('quit');
  assert.equal(host.listeners[0].closed, 1);
});

test('relay is lazy and desktop-only, reuses unremembered credentials without following later login changes', async () => {
  const host = fixture();
  assert.equal(host.call('relay:status').enabled, false);
  assert.equal(host.imported.length, 0);
  await assert.rejects(host.call('relay:configure', true), /先启用 Web/);
  await host.call('login:save', { ...config, mode: 'remote', remember: false });
  await host.call('remote:configure', { enabled: true, port: 17890 });
  await host.call('relay:configure', true);
  const first = host.relays[0];
  assert.equal(first.options.config.token, config.token);
  assert.match(first.options.deviceId, /^[a-f0-9]{32}$/);
  assert.ok([...host.files.values()].every((text) => !text.includes(config.token)));
  await host.call('login:save', { ...config, mode: 'remote', url: 'wss://other.example/ws' });
  await host.call('proxy:connect', config);
  await host.call('proxy:disconnect');
  assert.equal(first.closed, 0);
  assert.equal(host.relays.length, 1);
  first.options.onStatus({
    state: 'online',
    url: 'https://relay.example/remote/workstation/',
    error: null,
  });
  await host.call('relay:open');
  assert.equal(host.opened[0], 'https://relay.example/remote/workstation/#pair=pairing-code');
  assert.ok(!host.opened[0].includes(config.token));
  await host.call('relay:configure', false);
  assert.equal(first.closed, 1);
});

test('relay follows successful Web port changes and resumes the old listener after a failed host rebind', async () => {
  const host = fixture();
  await host.call('login:save', { ...config, mode: 'remote' });
  await host.call('remote:configure', { enabled: true, port: 17890 });
  await host.call('relay:configure', true);
  const id = host.relays[0].options.deviceId;
  await host.call('remote:configure', { enabled: true, port: 17891 });
  assert.equal(host.relays[0].closed, 1);
  assert.equal(host.relays[1].options.port, 17891);
  assert.equal(host.relays[1].options.deviceId, id);
  host.failListener();
  await assert.rejects(host.call('remote:configure', { enabled: true, port: 17892 }), /EADDRINUSE/);
  assert.equal(host.relays[1].closed, 0);
  host.failListener();
  await assert.rejects(host.call('remote:configure', { enabled: true, lan: true }), /EADDRINUSE/);
  assert.equal(host.relays[1].closed, 1);
  assert.equal(host.relays[2].options.port, 17891);
  assert.equal(host.call('remote:status').lan, false);
  await host.call('remote:configure', { enabled: false });
  assert.equal(host.relays[2].closed, 1);
  assert.equal(host.call('relay:status').enabled, false);
  await host.call('remote:configure', { enabled: true });
  assert.equal(host.relays.length, 3);
});

test('quit closes relay even after the business connection is disconnected', async () => {
  const host = fixture();
  await host.call('login:save', { ...config, mode: 'remote' });
  await host.call('remote:configure', { enabled: true });
  await host.call('relay:configure', true);
  let prevented = false;
  host.emit('before-quit', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(host.relays[0].closed, 1);
  await nextTurn();
  assert.equal(host.quits(), 1);
  assert.equal(host.call('relay:status').enabled, false);
});

test('relay ignores legacy public entry preferences and accepts only a boolean switch', async () => {
  const host = fixture();
  await host.call('login:save', { ...config, mode: 'remote' });
  const file = [...host.files.keys()].find((name) => name.endsWith('settings.json'));
  host.files.set(file, JSON.stringify({ relayControl: { origin: 'https://old.example:8443' } }));
  assert.equal('origin' in host.call('relay:status'), false);
  await host.call('remote:configure', { enabled: true });
  host.call('device:get');
  const saved = host.files.get(file);
  await host.call('relay:configure', true);
  const first = host.relays[0];
  assert.equal('origin' in first.options.config, false);
  assert.equal(first.options.config.url, config.url);
  assert.equal(host.files.get(file), saved);
  for (const value of [
    null,
    [],
    {},
    { enabled: true },
    { origin: 'https://other.example' },
    'true',
    1,
  ])
    await assert.rejects(host.call('relay:configure', value), /Invalid relay configuration/);
  assert.equal(first.closed, 0);
  assert.equal(host.relays.length, 1);
  await host.call('relay:configure', false);
  assert.equal(host.files.get(file), saved);
  const restarted = fixture(host.files);
  assert.equal(restarted.call('relay:status').enabled, false);
  assert.equal(restarted.relays.length, 0);
  assert.equal(restarted.listeners.length, 0);
});

test('concurrent relay and listener IPC requests run in order and only the last enable remains active', async () => {
  const host = fixture();
  await host.call('login:save', { ...config, mode: 'remote' });
  await host.call('remote:configure', { enabled: true, port: 17890 });
  await Promise.all([
    host.call('relay:configure', true),
    host.call('relay:configure', true),
    host.call('remote:configure', { enabled: true, port: 17891 }),
    host.call('relay:configure', false),
    host.call('relay:configure', true),
  ]);
  assert.equal(host.relays.length, 3);
  assert.deepEqual(
    host.relays.map((relay) => relay.closed),
    [1, 1, 0],
  );
  assert.deepEqual(
    host.relays.map((relay) => relay.options.port),
    [17890, 17891, 17891],
  );
  assert.equal(host.call('relay:status').enabled, true);
  const current = host.relays[2];
  current.options.onStatus({ state: 'online', url: 'https://relay.example/current/', error: null });
  host.relays[0].options.onStatus({ state: 'error', url: null, error: 'stale generation' });
  await host.call('relay:open');
  assert.equal(host.opened[0], 'https://relay.example/current/#pair=pairing-code');
  await Promise.all([
    host.call('remote:configure', { enabled: false }),
    host.call('relay:configure', false),
  ]);
  assert.equal(current.closed, 1);
  assert.equal(host.call('relay:status').enabled, false);
});

test('switching business service changes only the next explicit relay enable, not a listener rebind', async () => {
  const host = fixture();
  await host.call('login:save', { ...config, mode: 'remote' });
  await host.call('remote:configure', { enabled: true, port: 17890 });
  await host.call('relay:configure', true);
  const replacement = {
    ...config,
    mode: 'remote',
    url: 'wss://replacement.example/ws',
    token: 'next',
  };
  await host.call('login:save', replacement);
  await host.call('proxy:connect', replacement);
  await host.call('remote:configure', { enabled: true, port: 17891 });
  assert.equal(host.relays[1].options.config.url, config.url);
  assert.equal(host.relays[1].options.config.token, config.token);
  await host.call('relay:configure', false);
  await host.call('relay:configure', true);
  assert.equal(host.relays[2].options.config.url, replacement.url);
  assert.equal(host.relays[2].options.config.token, replacement.token);
  assert.equal(host.bridges[0].closed, 0);
});
