import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProxyClient } from '../src/client.ts';
import {
  RemoteClient,
  createRemoteClientAdapter,
  bridgeRemoteClientRequest,
} from '../src/remote-client.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;
test('diagnostic DOMExceptions are plain data before crossing the isolated Electron context', async () => {
  const request = { id: randomUUID(), viewId: 'page', method: 'client:probe', args: [] };
  for (const name of ['AbortError', 'TimeoutError']) {
    const result = await bridgeRemoteClientRequest(() => {
      throw new DOMException('diagnostic outcome', name);
    }, request);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      diagnostic: true,
      ok: false,
      error: 'diagnostic outcome',
      code: name,
    });
  }
  assert.deepEqual(await bridgeRemoteClientRequest(() => 7, request), {
    diagnostic: true,
    ok: true,
    result: 7,
  });
  await assert.rejects(
    bridgeRemoteClientRequest(
      () => {
        throw new Error('business');
      },
      { ...request, method: 'client:request' },
    ),
    /business/,
  );
});
function desktop(t, probeService) {
  const previous = globalThis.window;
  const cancelled = [];
  globalThis.window = {
    desktop: { probeService, cancelServiceProbe: async (id) => cancelled.push(id) },
  };
  const client = new ProxyClient();
  client.update({ status: 'connected', connectionId: randomUUID() });
  t.after(() => {
    globalThis.window = previous;
  });
  return { client, cancelled };
}

test('desktop latency uses the authenticated connection ID and cleans its state listener', async (t) => {
  const calls = [];
  const { client } = desktop(t, async (request) => {
    calls.push(request);
    return 12.5;
  });
  const before = client.state;
  assert.deepEqual(await client.measureLatency('service', signal()), {
    elapsed: 12.5,
    service: 12.5,
  });
  assert.equal(calls[0].connectionId, before.connectionId);
  assert.match(calls[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(client.listeners.size, 0);
  assert.equal(client.state, before);
});

test('desktop cancellation releases IPC and ignores a late result', async (t) => {
  let complete;
  const { client, cancelled } = desktop(
    t,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = client.measureLatency('service', controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  complete(25);
  await turn();
  assert.equal(cancelled.length, 1);
  assert.equal(client.listeners.size, 0);
  assert.equal(client.state.status, 'connected');
  assert.equal(client.state.error, null);
});

test('desktop switching connection cancels rather than attributing a result to the new service', async (t) => {
  const { client, cancelled } = desktop(t, () => new Promise(() => {}));
  const pending = assert.rejects(client.measureLatency('service', signal()), {
    name: 'AbortError',
  });
  client.update({ connectionId: randomUUID() });
  await pending;
  assert.equal(cancelled.length, 1);
  assert.equal(client.listeners.size, 0);
});

test('desktop diagnostic timeout never reconnects or modifies business error state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, cancelled } = desktop(t, () => new Promise(() => {}));
  const before = client.state;
  const pending = assert.rejects(client.measureLatency('service', signal()), {
    name: 'TimeoutError',
  });
  t.mock.timers.tick(4000);
  await pending;
  assert.equal(cancelled.length, 1);
  assert.equal(client.state, before);
  assert.equal(client.listeners.size, 0);
});

test('desktop preserves timeout semantics after Electron serializes an error', async (t) => {
  const { client } = desktop(t, async () => {
    throw new Error("Error invoking remote method 'proxy:probe': Error: 延迟测试超时。");
  });
  await assert.rejects(client.measureLatency('service', signal()), { name: 'TimeoutError' });
  assert.equal(client.state.error, null);
});

test('unsupported, disconnected, cancelled and malformed desktop probes produce no invented results', async (t) => {
  let calls = 0;
  const { client } = desktop(t, async () => {
    calls++;
    return Infinity;
  });
  await assert.rejects(client.measureLatency('service', AbortSignal.abort()), {
    name: 'AbortError',
  });
  await assert.rejects(client.measureLatency('workbench', signal()), /不支持/);
  assert.equal(calls, 0);
  await assert.rejects(client.measureLatency('service', signal()), /无效结果/);
  client.update({ status: 'disconnected' });
  await assert.rejects(client.measureLatency('service', signal()), /尚未连接/);
  assert.equal(calls, 1);
  assert.equal(client.listeners.size, 0);
});

async function browsers(t, count = 1) {
  const previous = globalThis.WebSocket;
  const source = new ProxyClient();
  source.update({ status: 'connected', connectionId: randomUUID() });
  const sockets = [];
  const adapter = createRemoteClientAdapter(source, ({ viewId, message }) => {
    sockets.find((socket) => socket.viewId === viewId)?.message(message);
  });
  const calls = [];
  let handler = async () => ({ elapsed: 7, service: 7 });
  source.measureLatency = (kind, signal) => {
    calls.push({ kind, signal });
    return handler(kind, signal);
  };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    hold = false;
    constructor(url) {
      this.viewId = url;
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(text) {
      const value = JSON.parse(text);
      this.sent.push(value);
      if (this.hold && value.method === 'client:probe') return;
      // Main-to-renderer IPC intentionally assigns a different ID from the browser's wire ID.
      void adapter.invoke({ ...value, id: randomUUID(), viewId: this.viewId }).then(
        (result) => this.message({ type: 'response', id: value.id, ok: true, result }),
        (error) =>
          this.message({
            type: 'response',
            id: value.id,
            ok: false,
            error: error.message,
            code: error.name,
          }),
      );
    }
    message(message) {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
      void adapter.invoke({
        id: randomUUID(),
        viewId: this.viewId,
        method: 'client:detach',
        args: [],
      });
    }
  }
  globalThis.WebSocket = Socket;
  adapter.setEnabled(true);
  const clients = Array.from({ length: count }, () => new RemoteClient());
  for (const [index, client] of clients.entries())
    client.connect(`ws://127.0.0.1/${index}`, '', {});
  await turn();
  for (const socket of sockets) socket.open();
  await turn();
  t.after(() => {
    for (const client of clients) client.disconnect();
    adapter.dispose();
    globalThis.WebSocket = previous;
  });
  return {
    source,
    clients,
    sockets,
    adapter,
    calls,
    setHandler: (next) => {
      handler = next;
    },
  };
}

test('browser echo uses its existing workbench socket without querying or publishing business state', async (t) => {
  const f = await browsers(t);
  const before = f.source.state;
  const result = await f.clients[0].measureLatency('workbench', signal());
  assert.ok(result.elapsed >= 0);
  assert.equal(result.service, undefined);
  assert.equal(f.source.state, before);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    f.sockets[0].sent.map((message) => message.method),
    ['client:state', 'client:probe'],
  );
  assert.equal(f.clients[0].listeners.size, 0);
});

test('browser nested probe waits for the actual service pong and returns its separately measured RTT', async (t) => {
  const f = await browsers(t);
  let complete;
  f.setHandler(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  let settled = false;
  const pending = f.clients[0].measureLatency('service', signal()).then((result) => {
    settled = true;
    return result;
  });
  await turn();
  assert.equal(settled, false);
  complete({ elapsed: 4, service: 4 });
  const result = await pending;
  assert.ok(result.elapsed >= 0);
  assert.equal(result.service, 4);
  assert.equal(f.calls.length, 1);
  assert.equal(f.clients[0].listeners.size, 0);
});

test('browser cancellation is correlated across distinct IPC IDs and isolated from another browser', async (t) => {
  const f = await browsers(t, 2);
  f.setHandler(
    (_kind, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), {
          once: true,
        }),
      ),
  );
  const one = new AbortController();
  const two = new AbortController();
  const first = assert.rejects(f.clients[0].measureLatency('service', one.signal), {
    name: 'AbortError',
  });
  const second = assert.rejects(f.clients[1].measureLatency('service', two.signal), {
    name: 'AbortError',
  });
  await turn();
  one.abort();
  await first;
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls[1].signal.aborted, false);
  two.abort();
  await second;
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.source.state.status, 'connected');
});

test('browser may not cancel another view by knowing its probe ID', async (t) => {
  const f = await browsers(t, 2);
  f.setHandler(
    (_kind, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), {
          once: true,
        }),
      ),
  );
  const controller = new AbortController();
  const first = assert.rejects(f.clients[0].measureLatency('service', controller.signal), {
    name: 'AbortError',
  });
  await turn();
  const probeId = f.sockets[0].sent.at(-1).id;
  await f.adapter.invoke({
    id: randomUUID(),
    viewId: f.sockets[1].viewId,
    method: 'client:cancel-probe',
    args: [f.source.state.connectionId, probeId],
  });
  assert.equal(f.calls[0].signal.aborted, false);
  controller.abort();
  await first;
});

test('browser timeout cancels only its diagnostic, ignores late replies and sends no retries', async (t) => {
  const f = await browsers(t);
  f.sockets[0].hold = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = f.clients[0].state;
  const rejected = assert.rejects(f.clients[0].measureLatency('service', signal()), {
    name: 'TimeoutError',
  });
  const sent = f.sockets[0].sent.at(-1);
  t.mock.timers.tick(6000);
  await rejected;
  f.sockets[0].message({ type: 'response', id: sent.id, ok: true, result: 25 });
  assert.equal(f.clients[0].state, before);
  assert.equal(f.clients[0].listeners.size, 0);
  assert.equal(f.sockets[0].sent.filter((message) => message.method === 'client:probe').length, 1);
  assert.equal(f.sockets[0].sent.at(-1).method, 'client:cancel-probe');
  assert.equal(f.sockets[0].readyState, 1);
});

test('browser service timeout survives transport serialization without becoming a connection error', async (t) => {
  const f = await browsers(t);
  f.setHandler(async () => {
    throw new DOMException('延迟测试超时。', 'TimeoutError');
  });
  await assert.rejects(f.clients[0].measureLatency('service', signal()), {
    name: 'TimeoutError',
    serviceTimedOut: true,
  });
  assert.equal(f.clients[0].state.error, null);
  assert.equal(f.clients[0].state.status, 'connected');
  assert.equal(f.clients[0].listeners.size, 0);
});

test('a cancelled service probe stops before the delayed desktop snapshot announces the connection change', async (t) => {
  const f = await browsers(t);
  const old = f.clients[0].state.connectionId;
  f.setHandler(
    (_kind, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), {
          once: true,
        }),
      ),
  );
  const pending = assert.rejects(f.clients[0].measureLatency('service', signal()), {
    name: 'AbortError',
  });
  await turn();
  f.source.update({ connectionId: randomUUID() });
  // Do not flush the new snapshot: the cancelled diagnostic reply wins this race.
  await pending;
  assert.equal(f.clients[0].state.connectionId, old);
  assert.equal(f.clients[0].state.status, 'connected');
  await assert.rejects(f.clients[0].measureLatency('service', signal()), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
});

for (const ending of ['switch', 'close', 'disable']) {
  test(`browser ${ending} cancels in-flight probes without adopting a late result`, async (t) => {
    const f = await browsers(t);
    f.setHandler(
      (_kind, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), {
            once: true,
          }),
        ),
    );
    const pending = assert.rejects(f.clients[0].measureLatency('service', signal()), /取消|cancel/);
    await turn();
    if (ending === 'switch') {
      f.source.update({ connectionId: randomUUID() });
      f.adapter.flush();
    } else if (ending === 'close') f.sockets[0].close();
    else f.adapter.setEnabled(false);
    await pending;
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.clients[0].listeners.size, 0);
  });
}

test('diagnostics validate view, connection, payload and per-view rate without affecting business requests', async (t) => {
  const f = await browsers(t);
  const invoke = (args, viewId = f.sockets[0].viewId) =>
    f.adapter.invoke({ id: randomUUID(), method: 'client:probe', viewId, args });
  await assert.rejects(
    invoke([f.source.state.connectionId, 'workbench', randomUUID()], 'unknown'),
    /先同步/,
  );
  await assert.rejects(invoke([randomUUID(), 'service', randomUUID()]), /连接已变化/);
  await assert.rejects(invoke([f.source.state.connectionId, 'anything', randomUUID()]), /格式无效/);
  for (let i = 0; i < 32; i++)
    await invoke([f.source.state.connectionId, 'workbench', randomUUID()]);
  await assert.rejects(
    invoke([f.source.state.connectionId, 'workbench', randomUUID()]),
    /过于频繁/,
  );
  assert.equal(f.source.state.status, 'connected');
  assert.equal(f.source.state.error, null);
});
