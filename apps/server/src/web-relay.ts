import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { createWebSocketStream, WebSocket, WebSocketServer } from 'ws';
import { Throttle } from './throttle.ts';

const DEVICE_ID = /^[a-f0-9]{32}$/;
const ROUTE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SECRET = /^[a-f0-9]{64}$/;
const MAX_DEVICES = 64;
const MAX_CHANNELS = 512;
const MAX_DEVICE_CHANNELS = 64;
const MAX_PENDING = 128;
const MAX_DEVICE_PENDING = 16;
const AUTH_MS = 5000;
const ATTACH_MS = 10_000;
const DRAIN_MS = 30_000;
const DATA_STALL_MS = 120_000;
const MAX_UPGRADE_HEAD = 64 * 1024;
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function webRelayOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid relay origin');
  }
  if (
    !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.port === '0' ||
    value.trim() !== value
  )
    throw new Error('Invalid relay origin');
  return url.origin;
}

export type WebRelayOptions = { port?: number; publicPort?: number; origin?: string };
export function webRelayOptions(options: WebRelayOptions) {
  const port = options.port ?? 5270;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid Web relay listening port');
  if (
    options.publicPort !== undefined &&
    (!Number.isInteger(options.publicPort) || options.publicPort < 1 || options.publicPort > 65535)
  )
    throw new Error('Invalid PROXY_WEB_RELAY_PUBLIC_PORT');
  let origin: string | undefined;
  if (options.origin !== undefined) {
    try {
      origin = webRelayOrigin(options.origin);
    } catch {
      throw new Error('Invalid PROXY_WEB_RELAY_ORIGIN');
    }
  }
  return { port, publicPort: options.publicPort, origin };
}

function webRelayHostname(value: string) {
  if (!value || /[\s/@?#\\]/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return url.hostname === value && url.host === value && url.pathname === '/';
  } catch {
    return false;
  }
}

type Pending = {
  resolve: (stream: Duplex) => void;
  reject: (error: Error) => void;
  drain: () => void;
  timer: NodeJS.Timeout;
};
type Desktop = {
  socket: WebSocket;
  origin: URL;
  deviceId: string;
  route: string;
  connectionId: string;
  secret: string;
  relayKey: string;
  pending: Map<string, Pending>;
  channels: Set<WebSocket>;
  responses: Set<{ output: ServerResponse | Duplex; active: boolean }>;
};

function sameSecret(actual: string, expected: string) {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

// This is an optional transport, not another owner of the desktop's sessions or business connection.
// Only a deployment explicitly enabling its dedicated browser listener creates this transport.
export class WebRelay {
  private entrance: { protocol: 'http:' | 'https:'; publicPort: number; origin?: string };
  private authorized: (token: string) => boolean;
  private addressOf: (request: IncomingMessage) => string;
  private controls = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
  });
  private data = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  private desktops = new Map<string, Desktop>();
  private routes = new Map<string, Desktop>();
  private connections = new Map<string, Desktop>();
  private throttle = new Throttle();
  private signingIn = new Map<string, number>();
  private signingInCount = 0;
  private pendingCount = 0;
  private channelCount = 0;
  private responseCount = 0;
  private closed = false;

  constructor(
    entrance: { protocol: 'http:' | 'https:'; publicPort: number; origin?: string },
    authorized: (token: string) => boolean,
    addressOf: (request: IncomingMessage) => string,
  ) {
    const validated = webRelayOptions({ publicPort: entrance.publicPort, origin: entrance.origin });
    this.entrance = { ...entrance, origin: validated.origin };
    this.authorized = authorized;
    this.addressOf = addressOf;
  }

  private route(request: IncomingMessage) {
    const match = /^\/remote\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(\/[^\r\n]*|\?[^\r\n]*|)$/.exec(
      request.url ?? '',
    );
    if (!match) return undefined;
    return { desktop: this.routes.get(match[1]), route: match[1], path: match[2] || '/' };
  }

  private validOrigin(request: IncomingMessage, desktop: Desktop, upgrade = false) {
    return (
      request.headers.host === desktop.origin.host &&
      (request.headers.origin === undefined
        ? !upgrade
        : request.headers.origin === desktop.origin.origin)
    );
  }

  handleRequest(request: IncomingMessage, response: ServerResponse) {
    if (!request.url?.startsWith('/remote/')) return false;
    const route = this.route(request);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!route?.desktop) {
      response.writeHead(404).end();
      return true;
    }
    if (!this.validOrigin(request, route.desktop)) {
      response.writeHead(403).end();
      return true;
    }
    if (this.closed) {
      response.writeHead(503).end();
      return true;
    }
    if (!request.url.startsWith(`/remote/${route.route}/`)) {
      response
        .writeHead(308, {
          Location: `/remote/${route.route}/${route.path.startsWith('?') ? route.path : ''}`,
        })
        .end();
      return true;
    }
    void this.proxy(request, response, route.desktop, route.path);
    return true;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const pathname = request.url;
    if (pathname === '/_relay/control' || pathname === '/_relay/data') {
      const address = this.address(request);
      if (this.closed || request.headers.origin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return true;
      }
      // A page opens several data connections together. This transport has its own allowance instead
      // of taking the four unauthenticated business-connection places belonging to the same address.
      const count = this.signingIn.get(address) ?? 0;
      if (this.throttle.blocked(address) || this.signingInCount >= 128 || count >= 32) {
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${this.throttle.blocked(address) || 5}\r\nConnection: close\r\n\r\n`,
        );
        return true;
      }
      this.signingIn.set(address, count + 1);
      this.signingInCount++;
      const server = pathname === '/_relay/control' ? this.controls : this.data;
      let accepted = false;
      const leave = () => {
        if (!accepted) {
          accepted = true;
          const remaining = (this.signingIn.get(address) ?? 1) - 1;
          if (remaining) this.signingIn.set(address, remaining);
          else this.signingIn.delete(address);
          this.signingInCount--;
        }
      };
      socket.once('close', leave);
      server.handleUpgrade(request, socket, head, (ws) => {
        socket.off('close', leave);
        this.authenticate(ws, address, pathname === '/_relay/control', leave);
      });
      return true;
    }
    if (!pathname?.startsWith('/remote/')) return false;
    const route = this.route(request);
    if (!route?.desktop) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return true;
    }
    if (this.closed || !this.validOrigin(request, route.desktop, true)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    // Only the local Web control endpoint upgrades; the relay is not a general-purpose TCP proxy.
    if (
      request.method !== 'GET' ||
      route.path.split('?')[0] !== '/api/control' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket'
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return true;
    }
    socket.pause();
    socket.on('error', () => socket.destroy());
    void this.proxyUpgrade(request, socket, head, route.desktop, route.path);
    return true;
  }

  private address(request: IncomingMessage) {
    const address = this.addressOf(request);
    return isIP(address) ? address : (request.socket.remoteAddress ?? '127.0.0.1');
  }

  private authenticate(socket: WebSocket, address: string, control: boolean, leave: () => void) {
    const timer = setTimeout(() => socket.terminate(), AUTH_MS);
    timer.unref();
    let missed = 0;
    let lastProgress = Date.now();
    let lastBuffered = 0;
    let dataStream: Duplex | undefined;
    const progressed = () => {
      lastProgress = Date.now();
      missed = 0;
    };
    let heartbeat: NodeJS.Timeout | undefined;
    const startHeartbeat = () => {
      lastProgress = Date.now();
      heartbeat = setInterval(() => {
        if (!control) {
          const buffered = socket.bufferedAmount;
          if (buffered < lastBuffered) progressed();
          lastBuffered = buffered;
          // A paused stream cannot read pong frames behind its payload; a blocked writer may not
          // send its ping either. Count data progress instead, with a bounded stalled-transfer wait.
          if (socket.isPaused || buffered > 0) {
            missed = 0;
            if (Date.now() - lastProgress >= DATA_STALL_MS) {
              // A closed WebSocket only queues EOF in its stream. Propagate a failure too, so a
              // backpressured HTTP parser/browser cannot keep that unread tail and its slot forever.
              dataStream?.destroy(new Error('Relay data stalled'));
              socket.terminate();
            }
            return;
          }
          lastProgress = Date.now();
        }
        if (missed >= 2) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) {
          missed++;
          socket.ping();
        }
      }, 15_000);
      heartbeat.unref();
    };
    socket.on('pong', () => {
      missed = 0;
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      leave();
    });
    socket.once('message', (raw, binary) => {
      let value: Record<string, unknown>;
      try {
        if (binary || !Buffer.isBuffer(raw) || raw.length > 8192) throw new Error('Invalid frame');
        value = JSON.parse(raw.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid frame');
      } catch {
        socket.close(4002, 'Invalid relay frame');
        return;
      }
      if (control) {
        if (
          value.type !== 'relay.register' ||
          value.version !== 2 ||
          typeof value.hostname !== 'string' ||
          !webRelayHostname(value.hostname) ||
          value.origin !== undefined ||
          typeof value.token !== 'string' ||
          typeof value.deviceId !== 'string' ||
          !DEVICE_ID.test(value.deviceId) ||
          (value.route !== undefined &&
            (typeof value.route !== 'string' || ROUTE.exec(value.route)?.[0] !== value.route)) ||
          typeof value.relayKey !== 'string' ||
          !SECRET.test(value.relayKey)
        ) {
          socket.close(4002, 'Invalid relay registration');
          return;
        }
        const origin = new URL(
          this.entrance.origin ??
            `${this.entrance.protocol}//${value.hostname}:${this.entrance.publicPort}`,
        );
        if (!this.authorized(value.token)) {
          this.throttle.fail(address);
          socket.close(4001, 'Invalid service token');
          return;
        }
        if (this.desktops.has(value.deviceId)) {
          socket.close(4009, 'Desktop already registered');
          return;
        }
        const route = (value.route as string | undefined) ?? value.deviceId;
        if (this.routes.has(route)) {
          socket.close(4010, 'Relay route already registered');
          return;
        }
        if (this.desktops.size >= MAX_DEVICES) {
          socket.close(1013, 'Relay capacity reached');
          return;
        }
        clearTimeout(timer);
        leave();
        startHeartbeat();
        this.throttle.succeed(address);
        const desktop: Desktop = {
          socket,
          origin,
          deviceId: value.deviceId,
          route,
          connectionId: randomUUID(),
          secret: randomBytes(32).toString('hex'),
          relayKey: value.relayKey,
          pending: new Map(),
          channels: new Set(),
          responses: new Set(),
        };
        this.desktops.set(desktop.deviceId, desktop);
        this.routes.set(desktop.route, desktop);
        this.connections.set(desktop.connectionId, desktop);
        socket.once('close', () => this.release(desktop));
        socket.on('message', (raw, binary) => this.control(desktop, raw, binary));
        socket.send(
          JSON.stringify({
            type: 'relay.ready',
            version: 2,
            connectionId: desktop.connectionId,
            secret: desktop.secret,
            origin: desktop.origin.origin,
            path: `/remote/${desktop.route}/`,
            capabilities: ['route'],
          }),
        );
      } else {
        const desktop =
          typeof value.connectionId === 'string'
            ? this.connections.get(value.connectionId)
            : undefined;
        const pending =
          typeof value.channelId === 'string' ? desktop?.pending.get(value.channelId) : undefined;
        if (
          value.type !== 'relay.attach' ||
          typeof value.connectionId !== 'string' ||
          typeof value.channelId !== 'string' ||
          typeof value.secret !== 'string' ||
          !SECRET.test(value.secret)
        ) {
          socket.close(4002, 'Invalid relay attachment');
          return;
        }
        if (!desktop) {
          socket.close(4004, 'Relay connection expired');
          return;
        }
        if (!sameSecret(value.secret, desktop.secret)) {
          this.throttle.fail(address);
          socket.close(4001, 'Invalid relay attachment');
          return;
        }
        if (!pending) {
          socket.close(4004, 'Relay channel expired');
          return;
        }
        clearTimeout(timer);
        leave();
        socket.on('message', progressed);
        startHeartbeat();
        desktop.pending.delete(value.channelId as string);
        this.pendingCount--;
        clearTimeout(pending.timer);
        desktop.channels.add(socket);
        this.channelCount++;
        socket.once('close', (code) => {
          desktop.channels.delete(socket);
          this.channelCount--;
          // Transport EOF can precede the HTTP parser's end while a browser is backpressured.
          // Begin its drain deadline now; abnormal closure must fail even an unread buffered tail.
          if (code === 1000 || code === 1005) pending.drain();
          else stream.destroy(new Error('Relay data disconnected'));
        });
        const stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
        dataStream = stream;
        stream.on('drain', progressed);
        stream.on('error', () => stream.destroy());
        pending.resolve(stream);
      }
    });
  }

  private control(desktop: Desktop, raw: unknown, binary: boolean) {
    let value: Record<string, unknown>;
    try {
      if (binary || !Buffer.isBuffer(raw) || raw.length > 8192) throw new Error('Invalid frame');
      value = JSON.parse(raw.toString());
      if (
        !value ||
        value.type !== 'relay.route' ||
        typeof value.id !== 'string' ||
        REQUEST_ID.exec(value.id)?.[0] !== value.id
      )
        throw new Error('Invalid frame');
    } catch {
      desktop.socket.close(4002, 'Unexpected relay control frame');
      return;
    }
    if (this.desktops.get(desktop.deviceId) !== desktop) return;
    const error =
      typeof value.route !== 'string' || ROUTE.exec(value.route)?.[0] !== value.route
        ? 'invalid_route'
        : this.routes.has(value.route) && this.routes.get(value.route) !== desktop
          ? 'route_in_use'
          : undefined;
    if (error) {
      desktop.socket.send(
        JSON.stringify({ type: 'relay.route-result', id: value.id, ok: false, error }),
      );
      return;
    }
    if (this.routes.get(desktop.route) === desktop) this.routes.delete(desktop.route);
    desktop.route = value.route as string;
    this.routes.set(desktop.route, desktop);
    desktop.socket.send(
      JSON.stringify({
        type: 'relay.route-result',
        id: value.id,
        ok: true,
        path: `/remote/${desktop.route}/`,
      }),
    );
  }

  private open(desktop: Desktop, signal: AbortSignal, drain: () => void) {
    return new Promise<Duplex>((resolve, reject) => {
      if (
        this.closed ||
        signal.aborted ||
        desktop.socket.readyState !== WebSocket.OPEN ||
        this.pendingCount >= MAX_PENDING ||
        desktop.pending.size >= MAX_DEVICE_PENDING ||
        this.channelCount + this.pendingCount >= MAX_CHANNELS ||
        desktop.channels.size + desktop.pending.size >= MAX_DEVICE_CHANNELS
      ) {
        reject(new Error('Relay unavailable'));
        return;
      }
      const channelId = randomUUID();
      const cancel = () => {
        const pending = desktop.pending.get(channelId);
        if (!pending) return;
        desktop.pending.delete(channelId);
        this.pendingCount--;
        pending.reject(new Error('Relay attachment timed out or request ended'));
      };
      const timer = setTimeout(cancel, ATTACH_MS);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      };
      desktop.pending.set(channelId, {
        timer,
        drain,
        resolve: (stream) => {
          cleanup();
          resolve(stream);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.pendingCount++;
      signal.addEventListener('abort', cancel, { once: true });
      desktop.socket.send(JSON.stringify({ type: 'relay.open', channelId }));
    });
  }

  private headers(request: IncomingMessage, desktop: Desktop, upgrade = false) {
    const headers: OutgoingHttpHeaders = {};
    const connection = new Set(
      (request.headers.connection ?? '')
        .toLowerCase()
        .split(',')
        .map((name) => name.trim()),
    );
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        HOP_HEADERS.has(name) ||
        connection.has(name) ||
        name === 'forwarded' ||
        name === 'x-real-ip' ||
        name.startsWith('x-forwarded-') ||
        name.startsWith('x-ccdt-relay-')
      )
        continue;
      headers[name] = value;
    }
    headers.host = desktop.origin.host;
    headers['x-ccdt-relay-key'] = desktop.relayKey;
    headers['x-ccdt-relay-address'] = this.address(request);
    headers.connection = upgrade ? 'Upgrade' : 'close';
    if (upgrade) headers.upgrade = 'websocket';
    return headers;
  }

  private response(desktop: Desktop, output: ServerResponse | Duplex) {
    if (this.responseCount >= MAX_CHANNELS || desktop.responses.size >= MAX_DEVICE_CHANNELS)
      return undefined;
    // A data WebSocket may have closed while the browser still has a queued response tail. Keep
    // its place until that tail drains, not merely until the transport channel disappears.
    const response = { output, active: false };
    desktop.responses.add(response);
    this.responseCount++;
    let timer: NodeJS.Timeout | undefined;
    const release = () => {
      clearTimeout(timer);
      output.off('finish', release);
      output.off('close', release);
      if (desktop.responses.delete(response)) this.responseCount--;
    };
    output.once('finish', release);
    output.once('close', release);
    output.once('error', () => output.destroy());
    return {
      start: () => {
        response.active = true;
      },
      drain: () => {
        if (timer || output.destroyed || output.writableFinished) return;
        // This deadline starts only at upstream EOF. It does not limit a long, progressing transfer.
        timer = setTimeout(() => output.destroy(), DRAIN_MS);
        timer.unref();
      },
    };
  }

  private async proxy(
    request: IncomingMessage,
    response: ServerResponse,
    desktop: Desktop,
    path: string,
  ) {
    const tracked = this.response(desktop, response);
    if (!tracked) {
      response.writeHead(503).end();
      return;
    }
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    request.once('aborted', () => abort.abort());
    let stream: Duplex | undefined;
    try {
      stream = await this.open(desktop, abort.signal, tracked.drain);
      if (abort.signal.aborted) {
        stream.destroy();
        return;
      }
      if (!this.connections.has(desktop.connectionId)) throw new Error('Desktop disconnected');
      tracked.start();
      const upstream = httpRequest({
        method: request.method,
        path,
        headers: this.headers(request, desktop),
        createConnection: () => stream!,
        signal: abort.signal,
      });
      const timeout = setTimeout(
        () => upstream.destroy(new Error('Relay response timeout')),
        60_000,
      );
      timeout.unref();
      upstream.once('close', () => {
        clearTimeout(timeout);
        stream?.destroy();
      });
      const fail = () => {
        if (!response.headersSent) {
          response.writeHead(502).end();
          tracked.drain();
        } else response.destroy();
      };
      upstream.on('error', fail);
      upstream.once('upgrade', (_response, remote) => {
        // An ordinary HTTP request has no upgraded browser socket to take ownership of this stream.
        clearTimeout(timeout);
        remote.destroy();
        fail();
      });
      upstream.once('response', (incoming) => {
        clearTimeout(timeout);
        const headers: OutgoingHttpHeaders = {};
        const connection = new Set(
          (incoming.headers.connection ?? '')
            .toLowerCase()
            .split(',')
            .map((name) => name.trim()),
        );
        for (const [name, value] of Object.entries(incoming.headers))
          if (!HOP_HEADERS.has(name) && !connection.has(name) && !name.startsWith('x-ccdt-relay-'))
            headers[name] = value;
        response.writeHead(incoming.statusCode ?? 502, headers);
        incoming.on('error', () => response.destroy());
        incoming.once('end', tracked.drain);
        incoming.pipe(response);
      });
      request.pipe(upstream);
    } catch {
      stream?.destroy();
      if (!response.destroyed) {
        response.writeHead(503).end();
        tracked.drain();
      }
    }
  }

  private async proxyUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    desktop: Desktop,
    path: string,
  ) {
    const tracked = this.response(desktop, socket);
    if (!tracked) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const abort = new AbortController();
    // Keep reading while the desktop attaches so a browser's FIN cancels the pending channel.
    // A paused socket would defer EOF until attachment (or its timeout). Retain only a bounded
    // early frame prefix; ordinary WebSocket clients wait for the 101 before sending frames.
    const early = head.length ? [head] : [];
    let earlyBytes = head.length;
    const cancel = () => {
      abort.abort();
      socket.destroy();
    };
    const remember = (chunk: Buffer) => {
      earlyBytes += chunk.length;
      if (earlyBytes > MAX_UPGRADE_HEAD) cancel();
      else early.push(chunk);
    };
    const stopReading = () => {
      socket.off('data', remember);
      socket.off('end', cancel);
    };
    socket.on('data', remember);
    socket.once('end', cancel);
    socket.once('close', () => {
      stopReading();
      early.length = 0;
      abort.abort();
    });
    socket.resume();
    if (earlyBytes > MAX_UPGRADE_HEAD) cancel();
    let stream: Duplex | undefined;
    try {
      stream = await this.open(desktop, abort.signal, tracked.drain);
      if (abort.signal.aborted) {
        stream.destroy();
        return;
      }
      if (!this.connections.has(desktop.connectionId)) throw new Error('Desktop disconnected');
      tracked.start();
      const upstream = httpRequest({
        method: 'GET',
        path,
        headers: this.headers(request, desktop, true),
        createConnection: () => stream!,
        signal: abort.signal,
      });
      const timeout = setTimeout(
        () => upstream.destroy(new Error('Relay upgrade timeout')),
        10_000,
      );
      timeout.unref();
      const fail = () => {
        clearTimeout(timeout);
        stream?.destroy();
        socket.destroy();
      };
      upstream.once('error', fail);
      upstream.once('response', (response) => {
        response.destroy();
        fail();
      });
      upstream.once('upgrade', (response, remote, remoteHead) => {
        clearTimeout(timeout);
        if (
          response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== 'websocket'
        ) {
          remote.destroy();
          fail();
          return;
        }
        socket.pause();
        stopReading();
        // Upgrade is hop-by-hop too: recreate this hop's handshake, without exposing relay-only
        // headers or headers nominated by the desktop's Connection field. Preserve repeated cookies.
        const connection = new Set(
          (response.headers.connection ?? '')
            .toLowerCase()
            .split(',')
            .map((name) => name.trim()),
        );
        let headers =
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index].toLowerCase();
          if (HOP_HEADERS.has(name) || connection.has(name) || name.startsWith('x-ccdt-relay-'))
            continue;
          headers += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
        }
        socket.write(headers + '\r\n');
        if (remoteHead.length) socket.write(remoteHead);
        for (const chunk of early) remote.write(chunk);
        early.length = 0;
        remote.on('error', () => socket.destroy());
        remote.once('end', tracked.drain);
        remote.once('close', () => {
          // A clean EOF has already called socket.end() through pipe(), but the browser's socket may
          // still be draining its final frame. Destroy only a broken stream, not that queued output.
          if (remote.errored || !remote.readableEnded) socket.destroy();
        });
        socket.once('close', () => remote.destroy());
        remote.pipe(socket);
        socket.pipe(remote);
        socket.resume();
      });
      upstream.end();
    } catch {
      stream?.destroy();
      socket.destroy();
    }
  }

  private release(desktop: Desktop) {
    if (this.desktops.get(desktop.deviceId) !== desktop) return;
    this.desktops.delete(desktop.deviceId);
    if (this.routes.get(desktop.route) === desktop) this.routes.delete(desktop.route);
    this.connections.delete(desktop.connectionId);
    for (const pending of desktop.pending.values()) {
      this.pendingCount--;
      pending.reject(new Error('Desktop disconnected'));
    }
    desktop.pending.clear();
    for (const socket of desktop.channels) socket.terminate();
    for (const response of desktop.responses) if (response.active) response.output.destroy();
  }

  async close() {
    this.closed = true;
    for (const desktop of this.desktops.values()) this.release(desktop);
    for (const socket of [...this.controls.clients, ...this.data.clients]) socket.terminate();
    await Promise.all(
      [this.controls, this.data].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
}
