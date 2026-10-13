import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  authSchema,
  commandSchema,
  deviceIdentitySchema,
  leaveSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  serverMessageSchema,
  terminalControlSchema,
} from '@cc-desk-tunnel/protocol';

const reads = new Set([
  'session.subscribe',
  'session.history',
  'session.status',
  'settings.get',
  'usage.summary',
  'usage.query',
]);
const globals = new Set(['session.updated', 'session.deleted', 'account.state', 'service.update']);
const fatalErrors = new Set([
  'unauthorized',
  'version_mismatch',
  'tunnel_failed',
  'ssh_failed',
  'connection_lost',
  'client_failed',
  'invalid_json',
]);

// Each view has its own request namespace, including when two pages submit the same UUID.
function requestId(namespace, id) {
  const bytes = createHash('sha256').update(`${namespace}:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Owns one execution connection independently of the windows displaying it. attach() accepts ONLY
 * transports already authenticated by the local random URL or the Web gateway. Their auth frames are
 * protocol handshakes, not authority to select an upstream service, credential, or execution device.
 * openObserver connects directly to the proxy service with the same certificate checks, not through SSH.
 */
export function createControlHub({
  openPrimary,
  openObserver,
  auth,
  device,
  requestTimeoutMs = 30_000,
  connectTimeoutMs = 50_000,
  maxBufferedBytes = 8 * 1024 * 1024,
  maxServerFrameBytes = 16 * 1024 * 1024,
  maxPending = 128,
  maxRemembered = 512,
  maxViews = 16,
}) {
  const credentials = authSchema.parse({ type: 'auth', ...auth, tunnel: false });
  if (credentials.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported hub protocol');
  const identity = deviceIdentitySchema.parse({
    type: 'device',
    id: device.id,
    ...(device.platform ? { platform: device.platform } : {}),
  });
  for (const value of [
    requestTimeoutMs,
    connectTimeoutMs,
    maxBufferedBytes,
    maxServerFrameBytes,
    maxPending,
    maxRemembered,
    maxViews,
  ])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid hub limit');
  const views = new Set();
  const pending = new Map();
  const terminals = new Map();
  let primary;
  let ready;
  let state = 'idle';
  let starting;
  let resolveStart;
  let rejectStart;
  let startTimer;
  let closing;

  function stopSocket(socket, code = 1000) {
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    // A dial that completes after its view has gone still needs an error listener before termination.
    socket.once('error', () => {});
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 250);
      timer.unref?.();
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(code);
    });
  }
  function write(socket, message) {
    const text = JSON.stringify(message);
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > maxBufferedBytes)
      return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }
  function send(view, message) {
    if (view.closed) return;
    if (!write(view.socket, message)) detach(view, 1013);
  }
  function error(view, code, message, id) {
    send(
      view,
      id
        ? { type: 'response', requestId: id, ok: false, code, message }
        : { type: 'connection.error', code, message },
    );
  }
  function globalMessage(message) {
    for (const view of views) {
      if (!view.authenticated) continue;
      if (view.ready) send(view, message);
      else {
        // A ready snapshot can be older than a primary update that arrives while its observer is opening.
        const key = message.type.startsWith('session.')
          ? `session:${message.sessionId ?? message.session.id}`
          : message.type;
        const previous = view.globals.get(key);
        view.globalBytes -= previous?.bytes ?? 0;
        const bytes = Buffer.byteLength(JSON.stringify(message));
        view.globalBytes += bytes;
        view.globals.set(key, { message, bytes });
        if (view.globalBytes > maxBufferedBytes || view.globals.size > maxRemembered)
          detach(view, 1013);
      }
    }
  }
  function removePending(entry) {
    clearTimeout(entry.timer);
    pending.delete(entry.upstreamId);
  }
  function finish(entry, response) {
    removePending(entry);
    entry.response = { ...response, requestId: entry.id };
    send(entry.view, entry.response);
    // Pending requests are never evicted; their effects may still be running.
    for (const [id, remembered] of entry.view.requests) {
      if (entry.view.requests.size <= maxRemembered) break;
      if (remembered.response) entry.view.requests.delete(id);
    }
  }
  function endTerminal(sessionId, terminalId) {
    return write(primary, {
      type: 'terminal.close',
      requestId: randomUUID(),
      sessionId,
      terminalId,
    });
  }
  function retireTerminal(sessionId, terminal) {
    // opened has no request ID: keep this session reserved until its original open fails or PTY closes.
    terminal.closing = true;
    if (terminal.id && !terminal.closeSent)
      terminal.closeSent = endTerminal(sessionId, terminal.id);
  }
  function detach(view, code = 1000) {
    if (view.closed) return;
    view.closed = true;
    views.delete(view);
    clearTimeout(view.timer);
    for (const entry of view.requests.values()) removePending(entry);
    view.requests.clear();
    view.globals.clear();
    for (const [sessionId, terminal] of terminals) {
      if (terminal.view !== view) continue;
      retireTerminal(sessionId, terminal);
    }
    void stopSocket(view.observer);
    void stopSocket(view.socket, code);
  }
  function shutdown(intentional, cause = new Error('执行连接已经结束。')) {
    if (closing) return closing;
    state = 'closed';
    clearTimeout(startTimer);
    rejectStart?.(cause);
    for (const view of [...views]) {
      if (!intentional) {
        if (cause.frame) send(view, cause.frame);
        else error(view, 'connection_lost', cause.message);
      }
      detach(view, intentional ? 1000 : 1011);
    }
    terminals.clear();
    // Only ending the hub, never closing a view, tells the proxy service that this device is leaving.
    if (intentional) write(primary, { type: 'leave' });
    closing = stopSocket(primary);
    return closing;
  }
  function decoded(raw, binary, limit = MAX_FRAME_BYTES) {
    if (binary || Buffer.byteLength(raw) > limit) throw new Error('Invalid frame');
    return JSON.parse(raw.toString('utf8'));
  }
  function primaryMessage(raw, binary) {
    if (state === 'closed') return;
    let message;
    try {
      message = serverMessageSchema.parse(decoded(raw, binary, maxServerFrameBytes));
    } catch {
      void shutdown(false, new Error('执行连接返回了不兼容的消息。'));
      return;
    }
    if (message.type.startsWith('tunnel.')) return;
    if (message.type === 'ready') {
      if (ready) return void shutdown(false, new Error('执行连接重复握手。'));
      ready = message;
      state = 'ready';
      clearTimeout(startTimer);
      resolveStart(ready);
      return;
    }
    if (message.type === 'connection.error') {
      if (fatalErrors.has(message.code))
        void shutdown(false, Object.assign(new Error(message.message), { frame: message }));
      else {
        // A terminal can end before input/ack reaches the proxy service; the execution connection survives.
        const recipients =
          message.code === 'terminal_inactive'
            ? new Set([...terminals.values()].map((terminal) => terminal.view))
            : views;
        for (const view of recipients) if (view.ready) send(view, message);
      }
      return;
    }
    if (globals.has(message.type)) return globalMessage(message);
    if (message.type.startsWith('terminal.')) {
      const terminal = terminals.get(message.sessionId);
      if (!terminal) {
        if (message.type === 'terminal.opened') endTerminal(message.sessionId, message.terminalId);
        return;
      }
      if (terminal.id && terminal.id !== message.terminalId) return;
      terminal.id = message.terminalId;
      if (message.type === 'terminal.closed') {
        terminals.delete(message.sessionId);
        send(terminal.view, message);
      } else if (terminal.closing) retireTerminal(message.sessionId, terminal);
      else send(terminal.view, message);
      return;
    }
    if ('requestId' in message) {
      if (message.type === 'response' && !message.ok) {
        // Timed-out/detached requests no longer live in pending, but still own their cleanup slot.
        for (const [sessionId, terminal] of terminals) {
          if (terminal.openRequestId !== message.requestId) continue;
          if (terminal.id) retireTerminal(sessionId, terminal);
          else terminals.delete(sessionId);
          break;
        }
      }
      const entry = pending.get(message.requestId);
      if (!entry || entry.observer) return;
      if (message.type === 'response') {
        finish(entry, message);
      } else send(entry.view, { ...message, requestId: entry.id });
    }
    // Session event streams come from observers, never primary's accumulated subscriptions. Global metadata
    // above must stay on primary: a create response assumes its preceding session.updated was already seen.
  }
  function start() {
    if (starting) return starting;
    if (state === 'closed') return Promise.reject(new Error('Control hub is closed'));
    state = 'starting';
    starting = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    startTimer = setTimeout(
      () => void shutdown(false, new Error('执行连接握手超时。')),
      connectTimeoutMs,
    );
    void Promise.resolve()
      .then(openPrimary)
      .then(
        (socket) => {
          if (state === 'closed') return void stopSocket(socket);
          primary = socket;
          socket.on('message', primaryMessage);
          socket.on('error', () => void shutdown(false, new Error('执行连接发生错误。')));
          socket.on('close', () => {
            if (state !== 'closed') void shutdown(false);
          });
          const greet = () => {
            if (state === 'closed') return;
            if (!write(socket, credentials) || !write(socket, identity))
              void shutdown(false, new Error('执行连接握手发送失败。'));
          };
          if (socket.readyState === WebSocket.OPEN) greet();
          else if (socket.readyState === WebSocket.CONNECTING) socket.once('open', greet);
          else void shutdown(false);
        },
        (cause) =>
          void shutdown(false, cause instanceof Error ? cause : new Error('执行连接失败。')),
      );
    return starting;
  }
  async function observe(view) {
    await start();
    if (view.closed) return;
    view.timer = setTimeout(() => {
      error(view, 'connection_lost', '会话读取连接握手超时。');
      detach(view, 1011);
    }, connectTimeoutMs);
    const socket = await openObserver();
    if (view.closed || state === 'closed') return void stopSocket(socket);
    view.observer = socket;
    socket.on('error', () => detach(view, 1011));
    socket.on('close', () => detach(view, 1011));
    socket.on('message', (raw, binary) => {
      if (view.closed) return;
      let message;
      try {
        message = serverMessageSchema.parse(decoded(raw, binary, maxServerFrameBytes));
      } catch {
        return detach(view, 1002);
      }
      if (message.type.startsWith('tunnel.') || message.type.startsWith('terminal.'))
        return detach(view, 1002);
      if (message.type === 'ready') {
        if (view.ready) return detach(view, 1002);
        clearTimeout(view.timer);
        view.ready = true;
        send(view, { ...message, connectionId: ready.connectionId });
        for (const queued of view.globals.values()) send(view, queued.message);
        view.globals.clear();
        view.globalBytes = 0;
      } else if ('requestId' in message) {
        const entry = pending.get(message.requestId);
        if (!entry || entry.view !== view || !entry.observer) return;
        if (message.type === 'response') finish(entry, message);
        else send(view, { ...message, requestId: entry.id });
      } else if (!globals.has(message.type)) send(view, message);
    });
    const greet = () => {
      if (!view.closed && !write(socket, credentials)) detach(view, 1011);
    };
    if (socket.readyState === WebSocket.OPEN) greet();
    else if (socket.readyState === WebSocket.CONNECTING) socket.once('open', greet);
    else detach(view, 1011);
  }
  function submit(view, command) {
    const serialized = JSON.stringify(command);
    const remembered = view.requests.get(command.requestId);
    if (remembered) {
      if (remembered.serialized !== serialized)
        error(view, 'request_conflict', '请求编号已被其他内容使用。', command.requestId);
      else if (remembered.response) send(view, remembered.response);
      return;
    }
    if (pending.size >= maxPending) {
      error(view, 'capacity', '等待处理的请求过多，请稍后再试。', command.requestId);
      return;
    }
    const terminal = terminals.get(command.sessionId);
    if (command.type === 'terminal.open' && terminal) {
      error(view, 'native_busy', '这个会话的原生终端已经打开。', command.requestId);
      return;
    }
    if (
      command.type === 'terminal.close' &&
      (!terminal ||
        terminal.closing ||
        terminal.view !== view ||
        terminal.id !== command.terminalId)
    ) {
      error(view, 'not_owner', '原生终端属于另一页面或已经结束。', command.requestId);
      return;
    }
    const entry = {
      id: command.requestId,
      upstreamId: requestId(view.id, command.requestId),
      view,
      command,
      serialized,
      observer: reads.has(command.type),
      response: null,
    };
    entry.timer = setTimeout(() => {
      if (command.type === 'terminal.open') {
        const current = terminals.get(command.sessionId);
        if (current?.openRequestId === entry.upstreamId) retireTerminal(command.sessionId, current);
      }
      finish(entry, {
        type: 'response',
        ok: false,
        code: 'request_timeout',
        message: '请求结果尚未确认；请查看会话状态，不要自动重发操作。',
      });
    }, requestTimeoutMs);
    pending.set(entry.upstreamId, entry);
    view.requests.set(entry.id, entry);
    if (command.type === 'terminal.open')
      terminals.set(command.sessionId, {
        view,
        id: null,
        openRequestId: entry.upstreamId,
        closing: false,
        closeSent: false,
      });
    if (
      !write(entry.observer ? view.observer : primary, { ...command, requestId: entry.upstreamId })
    ) {
      if (command.type === 'terminal.open') terminals.delete(command.sessionId);
      finish(entry, {
        type: 'response',
        ok: false,
        code: 'connection_lost',
        message: '连接正忙或已经断开。',
      });
    }
  }
  function attach(socket) {
    if (state === 'closed' || views.size >= maxViews) {
      void stopSocket(socket, 1013);
      return () => {};
    }
    const view = {
      id: randomUUID(),
      socket,
      requests: new Map(),
      globals: new Map(),
      globalBytes: 0,
      closed: false,
      authenticated: false,
      ready: false,
    };
    views.add(view);
    view.timer = setTimeout(() => detach(view, 4001), connectTimeoutMs);
    socket.on('error', () => detach(view, 1011));
    socket.on('close', () => detach(view));
    socket.on('message', (raw, binary) => {
      if (view.closed) return;
      let message;
      try {
        message = decoded(raw, binary);
      } catch {
        return detach(view, 1002);
      }
      if (!view.authenticated) {
        const parsed = authSchema.safeParse(message);
        if (!parsed.success || parsed.data.protocolVersion !== PROTOCOL_VERSION) {
          error(view, 'unauthorized', '页面握手格式或协议版本不正确。');
          return detach(view, 4001);
        }
        view.authenticated = true;
        clearTimeout(view.timer);
        void observe(view).catch(() => {
          error(view, 'connection_lost', '会话读取连接失败。');
          detach(view, 1011);
        });
        return;
      }
      if (deviceIdentitySchema.safeParse(message).success) return;
      if (leaveSchema.safeParse(message).success) return detach(view);
      if (!view.ready) return error(view, 'connection_lost', '页面连接尚未就绪。');
      const control = terminalControlSchema.safeParse(message);
      if (control.success) {
        const terminal = terminals.get(control.data.sessionId);
        if (
          !terminal ||
          terminal.closing ||
          terminal.view !== view ||
          terminal.id !== control.data.terminalId
        )
          return error(view, 'terminal_inactive', '原生终端属于另一页面或已经结束。');
        if (!write(primary, control.data))
          error(view, 'connection_lost', '终端连接正忙或已经断开。');
        return;
      }
      const parsed = commandSchema.safeParse(message);
      if (!parsed.success) return error(view, 'invalid_command', '请求格式无效。');
      submit(view, parsed.data);
    });
    return () => detach(view);
  }
  return {
    start,
    attach,
    close: () => shutdown(true),
    info: () => ({
      state,
      connectionId: ready?.connectionId ?? null,
      device: { ...device },
      views: views.size,
      pending: pending.size,
    }),
  };
}
