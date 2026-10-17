import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { probeSocket } from '../electron/socket-latency.mjs';

async function sockets(t, autoPong = true) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong });
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const [remote] = await accepted;
  await once(client, 'open');
  t.after(async () => {
    client.terminate();
    remote.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { client, remote };
}

const counts = (socket) => ['pong', 'close', 'error'].map((name) => socket.listenerCount(name));

test('latency uses the existing socket and leaves heartbeat listeners intact', async (t) => {
  const { client, remote } = await sockets(t);
  let heartbeats = 0;
  client.on('pong', () => heartbeats++);
  const before = counts(client);
  const received = once(remote, 'ping');
  const elapsed = await probeSocket(client);
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
  assert.match(String((await received)[0]), /^latency:[a-f0-9]{32}$/);
  assert.deepEqual(counts(client), before);
  assert.equal(heartbeats, 1);
  assert.equal(client.readyState, WebSocket.OPEN);
});

test('empty heartbeat and unrelated pongs never satisfy a probe', async (t) => {
  const { client, remote } = await sockets(t, false);
  let complete = false;
  const received = once(remote, 'ping');
  const measuring = probeSocket(client).then((value) => {
    complete = true;
    return value;
  });
  const [nonce] = await received;
  remote.pong();
  remote.pong('latency:unrelated');
  await delay(25);
  assert.equal(complete, false);
  remote.pong(nonce);
  assert.ok((await measuring) >= 20);
});

test('four concurrent probes match their own nonces; a fifth is bounded', async (t) => {
  const { client, remote } = await sockets(t, false);
  const received = [];
  remote.on('ping', (data) => received.push(data));
  const before = counts(client);
  const probes = Array.from({ length: 4 }, () => probeSocket(client));
  await assert.rejects(probeSocket(client), /频繁/);
  while (received.length < 4) await delay(5);
  assert.equal(new Set(received.map(String)).size, 4);
  for (const nonce of received.reverse()) remote.pong(nonce);
  for (const elapsed of await Promise.all(probes)) assert.ok(elapsed >= 0);
  assert.deepEqual(counts(client), before);
});

test('a timeout removes probe listeners without disconnecting or altering later probes', async (t) => {
  const { client, remote } = await sockets(t, false);
  const before = counts(client);
  await assert.rejects(probeSocket(client, { timeoutMs: 25 }), /延迟测试超时/);
  assert.deepEqual(counts(client), before);
  assert.equal(client.readyState, WebSocket.OPEN);
  remote.on('ping', (data) => remote.pong(data));
  assert.ok((await probeSocket(client)) >= 0);
});

test('abort before or during measurement leaves the connection usable', async (t) => {
  const { client, remote } = await sockets(t, false);
  const before = counts(client);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(probeSocket(client, { signal: aborted.signal }), /已取消/);
  const controller = new AbortController();
  const measuring = assert.rejects(probeSocket(client, { signal: controller.signal }), /已取消/);
  controller.abort();
  await measuring;
  assert.deepEqual(counts(client), before);
  assert.equal(client.readyState, WebSocket.OPEN);
  remote.on('ping', (data) => remote.pong(data));
  assert.ok((await probeSocket(client)) >= 0);
});

test('socket close rejects and cleans an outstanding probe', async (t) => {
  const { client, remote } = await sockets(t, false);
  const measuring = assert.rejects(probeSocket(client), /已断开/);
  remote.close();
  await measuring;
  assert.equal(client.listenerCount('pong'), 0);
  await assert.rejects(probeSocket(client), /未就绪/);
});

function fakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.bufferedAmount = 0;
  socket.ping = (data, callback) => {
    callback();
    queueMicrotask(() => socket.emit('pong', data));
  };
  return socket;
}

test('rate and send-queue limits bound tiny successful probes without closing the socket', async () => {
  const socket = fakeSocket();
  for (let index = 0; index < 20; index++) await probeSocket(socket);
  await assert.rejects(probeSocket(socket), /频繁/);
  socket.bufferedAmount = 65537;
  await assert.rejects(probeSocket(socket), /正忙/);
  assert.deepEqual(counts(socket), [0, 0, 0]);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test('send throw, callback error and socket error remove all probe listeners', async () => {
  for (const kind of ['throw', 'callback', 'socket']) {
    const socket = fakeSocket();
    socket.ping = (_data, callback) => {
      if (kind === 'throw') throw new Error('write failed');
      if (kind === 'callback') callback(new Error('write failed'));
      if (kind === 'socket') socket.emit('error', new Error('write failed'));
    };
    await assert.rejects(probeSocket(socket), /失败|错误/);
    assert.deepEqual(counts(socket), [0, 0, 0]);
  }
});
