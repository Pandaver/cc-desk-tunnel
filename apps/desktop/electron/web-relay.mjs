import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connect, isIP } from 'node:net';
import { WebSocket, createWebSocketStream } from 'ws';
import { certificateMatches, connectService, controlTlsOptions } from './proxy-bridge.mjs';
import { httpProxy, openSocket } from './system-proxy.mjs';

const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fatalClose = new Set([1002, 1003, 1007, 1008, 1009, 4001, 4002]);
const refused = () =>
  Object.assign(new Error('中继请求校验失败。'), { status: 403, statusCode: 403 });
const fault = (message, fatal = false) => Object.assign(new Error(message), { fatal });
const loopback = (address) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function publicOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const address = new URL(value);
    return (
      ['http:', 'https:'].includes(address.protocol) &&
      address.port !== '0' &&
      address.origin === value
    );
  } catch {
    return false;
  }
}
function certificateError(error) {
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS_CERT/.test(error?.code ?? '');
}

// A separate, optional connection: neither the business bridge nor its SSH channels own its lifetime.
// The relay can reach only this already-running Web listener. The service never supplies a target port.
export function startWebRelay({ config, deviceId, port, resolveProxy, onStatus, timing = {} }) {
  const address = new URL(config.url);
  if (
    !['ws:', 'wss:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('中继需要不含凭据、查询参数的 WS 或 WSS 服务地址。');
  if (!/^[a-f0-9]{32}$/.test(deviceId)) throw new Error('中继工作台标识无效。');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('本地 Web 监听端口无效。');
  if (typeof config.token !== 'string' || !config.token || config.token.length > 4096)
    throw new Error('请先填写服务凭据。');
  if (address.protocol === 'ws:' && config.fingerprint)
    throw new Error('证书指纹需要 WSS 服务地址。');
  if (address.protocol === 'wss:') controlTlsOptions(config);
  // Take a snapshot: changing a saved connection must not change credentials halfway through a dial.
  config = { ...config, waits: { ...config.waits } };
  const duration = (name, fallback) =>
    Number.isInteger(timing[name]) && timing[name] > 0 ? timing[name] : fallback;
  const waits = {
    connect: duration('connect', 15000),
    channel: duration('channel', 10000),
    register: duration('register', 15000),
    heartbeat: duration('heartbeat', 15000),
    reconnectMin: duration('reconnectMin', 1000),
    reconnectMax: duration('reconnectMax', 30000),
    idle: duration('idle', 120000),
    drain: duration('drain', 30000),
    maxChannels: Math.min(duration('maxChannels', 64), 128),
  };
  let closed = false;
  let active = null;
  let retry;
  let attempts = 0;
  let status = { state: 'connecting', url: null, error: null };

  function publish(state, url = null, error = null) {
    status = { state, url, error };
    onStatus?.({ ...status });
  }
  function current(generation) {
    return !closed && active === generation && !generation.ended;
  }
  function stopGeneration(generation) {
    if (generation.ended) return;
    generation.ended = true;
    generation.ready = null;
    clearTimeout(generation.timer);
    clearInterval(generation.heartbeat);
    for (const dispose of generation.disposers) dispose();
    generation.disposers.clear();
    for (const socket of generation.sockets) socket.terminate();
    generation.sockets.clear();
    for (const socket of generation.transports) socket.destroy();
    generation.transports.clear();
    for (const entry of generation.channels.values()) entry.close?.();
    generation.channels.clear();
  }
  function fail(generation, message, fatal = false) {
    if (!current(generation)) return;
    stopGeneration(generation);
    publish(fatal ? 'error' : 'offline', null, message);
    if (fatal || closed) return;
    const backoff = Math.min(
      waits.reconnectMin * 2 ** Math.min(attempts++, 16),
      waits.reconnectMax,
    );
    const delay = Math.max(1, Math.floor(backoff * (0.5 + Math.random() * 0.5)));
    retry = setTimeout(begin, delay);
    retry.unref?.();
  }

  // Both the HTTP upgrade and all credentials wait for the same TLS path as the native connection.
  // An async proxy lookup may finish after disable: its eventual socket is destroyed, never handed on.
  function dial(generation, path, timeout = waits.connect) {
    return new Promise((resolve, reject) => {
      const target = new URL(path, address);
      let settled = false;
      let timer;
      let socket;
      const connection = new AbortController();
      const cancel = () => finish(fault('中继连接已结束。'));
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        generation.disposers.delete(cancel);
        if (error) {
          connection.abort();
          socket?.terminate();
          reject(error);
        } else resolve(socket);
      };
      const transport = async () => {
        if (target.protocol === 'wss:')
          return connectService(
            { hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port },
            config,
            async () => {
              const proxy = await resolveProxy?.(
                `https://${target.hostname}:${target.port || 443}`,
              );
              if (!current(generation) || settled) throw fault('中继连接已结束。');
              return proxy;
            },
            undefined,
            connection.signal,
          );
        const host = target.hostname.replace(/^\[|\]$/g, '');
        const proxy = httpProxy(await resolveProxy?.(`http://${target.host}`));
        if (!current(generation) || settled) throw fault('中继连接已结束。');
        const transport = await openSocket(
          proxy,
          host,
          Number(target.port || 80),
          timeout,
          connection.signal,
        );
        transport.setKeepAlive(true, 30000);
        // CONNECT returns a paused socket; unlike TLS, plain WebSocket HTTP does not resume it.
        transport.resume();
        return transport;
      };
      socket = new WebSocket(target, {
        handshakeTimeout: timeout,
        perMessageDeflate: false,
        maxPayload: path === '/_relay/control' ? 8192 : 1024 * 1024,
        createConnection: (_options, created) => {
          transport().then(
            (connection) => {
              // Destroying an unconnected TLS socket can emit an error after its former owner left.
              connection.on('error', () => {});
              if (!current(generation) || settled) {
                connection.destroy();
                return;
              }
              generation.transports.add(connection);
              connection.once('close', () => generation.transports.delete(connection));
              created(null, connection);
            },
            (error) => {
              if (!settled) created(error);
            },
          );
        },
      });
      generation.sockets.add(socket);
      generation.disposers.add(cancel);
      timer = setTimeout(() => finish(fault('中继连接超时。')), timeout);
      timer.unref?.();
      socket.on('error', (error) => {
        const fatal = certificateError(error);
        finish(fault(fatal ? '中继服务证书校验失败。' : '中继连接失败。', fatal));
      });
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        finish(
          fault(
            [403, 404].includes(response.statusCode)
              ? '服务端中继未启用或版本不兼容，请检查服务端部署。'
              : '中继入口未就绪或接入被拒绝。',
            [400, 401, 403, 404, 426].includes(response.statusCode),
          ),
        );
      });
      socket.once('close', () => {
        generation.sockets.delete(socket);
        finish(fault('中继连接已断开。'));
      });
      socket.once('open', () => {
        if (!current(generation)) return cancel();
        if (
          config.fingerprint &&
          !certificateMatches(
            socket._socket.getPeerCertificate().fingerprint256,
            config.fingerprint,
          )
        )
          return finish(fault('中继服务证书指纹不匹配；未发送服务凭据。', true));
        finish();
      });
    });
  }

  async function attach(generation, channelId) {
    if (generation.channels.has(channelId))
      return fail(generation, '中继服务重复请求了同一连接。', true);
    if (generation.channels.size >= waits.maxChannels) return;
    const entry = {};
    generation.channels.set(channelId, entry);
    let channel;
    const deadline = Date.now() + waits.channel;
    for (let attempt = 0; current(generation); attempt++) {
      try {
        channel = await dial(
          generation,
          '/_relay/data',
          Math.max(1, Math.min(waits.connect, deadline - Date.now())),
        );
        break;
      } catch (error) {
        if (error.fatal || Date.now() >= deadline || !current(generation)) {
          generation.channels.delete(channelId);
          if (error.fatal) fail(generation, error.message, true);
          return;
        }
        // Retry only before attachment: not one HTTP byte has been forwarded yet. A shared-IP
        // handshake limit may briefly reject simultaneous asset requests without breaking the relay.
        await new Promise((resolve) => {
          const cancel = () => {
            clearTimeout(timer);
            generation.disposers.delete(cancel);
            resolve();
          };
          const backoff =
            Math.min(100 * 2 ** Math.min(attempt, 4), 1000) * (0.5 + Math.random() * 0.5);
          const timer = setTimeout(cancel, Math.min(backoff, Math.max(1, deadline - Date.now())));
          generation.disposers.add(cancel);
        });
      }
    }
    if (!current(generation) || !generation.ready) {
      channel?.terminate();
      return;
    }
    const { connectionId, secret } = generation.ready;
    channel.send(JSON.stringify({ type: 'relay.attach', connectionId, channelId, secret }));
    const stream = createWebSocketStream(channel, { highWaterMark: 64 * 1024 });
    const local = connect({ host: '127.0.0.1', port });
    let ended = false;
    let drain;
    let heard = Date.now();
    const alive = () => (heard = Date.now());
    channel.on('ping', alive);
    channel.on('pong', alive);
    channel.on('message', alive);
    const heartbeat = setInterval(() => {
      // A paused reader cannot reach a queued pong, and a blocked writer cannot send its ping.
      // Local TCP idle and EOF drain deadlines still bound a transfer that never resumes.
      if (channel.isPaused || channel.bufferedAmount > 0) alive();
      else if (Date.now() - heard > waits.heartbeat * 2.5) entry.close();
      else if (channel.readyState === WebSocket.OPEN) channel.ping();
    }, waits.heartbeat);
    heartbeat.unref?.();
    entry.close = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearTimeout(drain);
      generation.channels.delete(channelId);
      local.destroy();
      stream.destroy();
      channel.terminate();
    };
    local.setTimeout(waits.idle, entry.close);
    stream.on('error', entry.close);
    local.on('error', entry.close);
    local.once('end', () => {
      // A normal HTTP Connection: close ends the local TCP socket before a slow WebSocket has
      // necessarily sent its final chunk. Let pipe() end the writable and flush its close frame.
      // A peer that stops consuming still gets a bounded cleanup rather than an orphaned channel.
      drain = setTimeout(entry.close, waits.drain);
      drain.unref?.();
    });
    local.once('close', (hadError) => {
      if (hadError || !local.readableEnded) entry.close();
    });
    channel.once('close', (code) => {
      entry.close();
      if (fatalClose.has(code)) fail(generation, '中继数据连接校验失败。', true);
    });
    channel.on('error', (error) => {
      if (error.code?.startsWith('WS_ERR')) fail(generation, '中继数据连接协议无效。', true);
    });
    stream.pipe(local);
    local.pipe(stream);
  }

  async function begin() {
    if (closed) return;
    const generation = {
      ended: false,
      ready: null,
      relayKey: randomBytes(32).toString('hex'),
      sockets: new Set(),
      transports: new Set(),
      disposers: new Set(),
      channels: new Map(),
    };
    active = generation;
    publish('connecting');
    let control;
    try {
      control = await dial(generation, '/_relay/control');
    } catch (error) {
      fail(generation, error.message, error.fatal);
      return;
    }
    if (!current(generation)) return control.terminate();
    let heard = Date.now();
    const alive = () => (heard = Date.now());
    control.on('ping', alive);
    control.on('pong', alive);
    control.on('error', (error) => {
      const fatal = error.code?.startsWith('WS_ERR');
      fail(generation, fatal ? '中继控制连接协议无效。' : '中继连接已断开，正在重新连接。', fatal);
    });
    control.once('close', (code) => {
      const fatal = fatalClose.has(code);
      const message =
        code === 4009
          ? '正在等待这个工作台的旧中继连接释放。'
          : fatal
            ? '中继接入或协议校验失败，请检查服务配置。'
            : '中继连接已断开，正在重新连接。';
      fail(generation, message, fatal);
    });
    control.on('message', (data, binary) => {
      if (!current(generation)) return;
      alive();
      let message;
      try {
        if (binary) throw new Error();
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
        if (!generation.ready) {
          if (
            message.type !== 'relay.ready' ||
            message.version !== 2 ||
            !uuid.test(message.connectionId) ||
            !hex.test(message.secret) ||
            !publicOrigin(message.origin) ||
            message.path !== `/remote/${deviceId}/`
          )
            throw new Error();
          generation.ready = message;
          clearTimeout(generation.timer);
          attempts = 0;
          publish('online', `${message.origin}${message.path}`);
        } else {
          if (message.type !== 'relay.open' || !uuid.test(message.channelId)) throw new Error();
          void attach(generation, message.channelId);
        }
      } catch {
        fail(
          generation,
          message?.type === 'relay.ready' && message.version !== 2
            ? '中继协议版本不兼容，请更新服务端。'
            : '中继服务返回了无效协议消息。',
          true,
        );
      }
    });
    generation.timer = setTimeout(() => fail(generation, '中继服务注册超时。'), waits.register);
    generation.timer.unref?.();
    generation.heartbeat = setInterval(() => {
      if (Date.now() - heard > waits.heartbeat * 2.5)
        fail(generation, '中继服务长时间没有响应，正在重新连接。');
      else if (control.readyState === WebSocket.OPEN) control.ping();
    }, waits.heartbeat);
    generation.heartbeat.unref?.();
    control.send(
      JSON.stringify({
        type: 'relay.register',
        version: 2,
        token: config.token,
        deviceId,
        relayKey: generation.relayKey,
        hostname: address.hostname,
      }),
    );
  }

  // No connection is opened until the owner explicitly calls startWebRelay. Defer the first notification
  // so the owner can store the returned controller before its onStatus callback runs.
  queueMicrotask(() => void begin());
  return {
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retry);
      if (active) stopGeneration(active);
      publish('offline');
    },
    context(request) {
      const headers = request.headers ?? {};
      const supplied = Object.keys(headers).filter((name) => name.startsWith('x-ccdt-relay-'));
      if (!supplied.length) return null;
      const key = headers['x-ccdt-relay-key'];
      const client = headers['x-ccdt-relay-address'];
      if (
        !active ||
        !current(active) ||
        !active.ready ||
        !loopback(request.socket?.remoteAddress) ||
        supplied.some((name) => !['x-ccdt-relay-key', 'x-ccdt-relay-address'].includes(name)) ||
        typeof key !== 'string' ||
        !hex.test(key) ||
        !timingSafeEqual(Buffer.from(key), Buffer.from(active.relayKey)) ||
        typeof client !== 'string' ||
        !isIP(client)
      )
        throw refused();
      return { origin: active.ready.origin, basePath: active.ready.path, address: client };
    },
    get status() {
      return { ...status };
    },
  };
}
