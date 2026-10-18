import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { WebSocket } from 'ws';
import type { WebAccessState } from '@cc-desk-tunnel/protocol';
import { z } from 'zod';
import { DomainError } from './errors.ts';

const PAIR_MS = 5 * 60_000;
// Browsers cap cookie lifetimes; reading the session renews this cookie, not the grant.
const COOKIE_MS = 400 * 24 * 60 * 60_000;
const MAX_GRANTS = 64;
const MAX_PAIRS = 16;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const grantSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
    createdAt: z.iso.datetime(),
    expiresAt: z.null(),
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WebGrant = z.infer<typeof grantSchema>;
export type WebAccessOptions = { origin: string; directory: string };
const publicGrant = ({ secretHash: _, ...grant }: WebGrant) => grant;
const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function browserName(agent: string) {
  const family = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : '浏览器';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${family} · ${system}` : family;
}

// Browser grants are separate from the service credential and from execution devices. The file contains
// only hashes; a browser keeps its own opaque secret in a host-only, HttpOnly cookie. A grant lasts until
// explicitly revoked or logged out; it does not acquire a second lifetime from the browser cookie.
export class WebAccess {
  readonly origin: string;
  private readonly cookieName: string;
  private url: URL;
  private directory: string;
  private file: string;
  private grants = new Map<string, WebGrant>();
  private pairs = new Map<
    string,
    { owner: string; code: string; expires: number; expiresAt: string }
  >();
  private failures = new Map<string, { count: number; until: number }>();
  private pending = new Map<string, number>();
  private sockets = new Map<string, Set<WebSocket>>();
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private wallNow: () => number;
  private changed: () => void;
  private closed = false;
  private serving = 0;

  constructor(
    options: WebAccessOptions,
    dataDir: string,
    transport: { tls?: boolean; reverseProxy?: boolean; host?: string } = {},
    now?: () => number,
    changed = () => {},
  ) {
    this.now = now ?? (() => performance.now());
    this.wallNow = now ?? Date.now;
    this.changed = changed;
    this.url = new URL(options.origin);
    if (
      this.url.origin !== options.origin ||
      this.url.username ||
      this.url.password ||
      !['https:', 'http:'].includes(this.url.protocol)
    )
      throw new Error('Web origin must be an exact HTTP(S) origin without a path or credentials.');
    if (
      this.url.protocol === 'http:' &&
      (!loopback(this.url.hostname) || !loopback(transport.host ?? '127.0.0.1'))
    )
      throw new Error('Web access requires HTTPS, except on a loopback development listener.');
    if (this.url.protocol === 'https:' && !transport.tls && !transport.reverseProxy)
      throw new Error('HTTPS Web access requires TLS or explicit reverse proxy mode.');
    this.origin = this.url.origin;
    // Cookies ignore ports. Isolate services on the same host, including HTTP development and HTTPS.
    this.cookieName = `cc_web_session_${hash(this.origin).slice(0, 16)}`;
    this.directory = resolve(options.directory);
    this.file = join(dataDir, 'web-grants.json');
    try {
      const records = z
        .array(grantSchema)
        .max(MAX_GRANTS)
        .parse(JSON.parse(readFileSync(this.file, 'utf8')));
      for (const grant of records) this.grants.set(grant.id, grant);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Web grant storage is unreadable or invalid.');
    }
  }

  private save(grants = this.grants) {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify([...grants.values()]), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private disconnect(id: string, stopping = false) {
    for (const socket of this.sockets.get(id) ?? [])
      socket.close(
        stopping ? 1012 : 4001,
        stopping ? 'Web access stopped' : 'Browser session revoked',
      );
    this.sockets.delete(id);
  }

  private expire() {
    const now = this.now();
    const before = this.pairs.size;
    for (const [key, pair] of this.pairs) if (pair.expires <= now) this.pairs.delete(key);
    for (const [key, entry] of this.failures) if (entry.until <= now) this.failures.delete(key);
    if (before !== this.pairs.size) {
      this.scheduleExpiry();
      this.changed();
    }
  }

  private scheduleExpiry() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.pairs.size) return;
    const next = Math.min(...[...this.pairs.values()].map((pair) => pair.expires));
    this.timer = setTimeout(() => this.expire(), Math.max(1, Math.ceil(next - this.now())));
    this.timer.unref();
  }

  state(owner?: string): WebAccessState {
    this.expire();
    const pair = [...this.pairs.values()].find((pair) => pair.owner === owner);
    return {
      enabled: !this.closed,
      origin: this.origin,
      ...(pair
        ? {
            pairing: {
              code: pair.code,
              expiresAt: pair.expiresAt,
              remainingMs: Math.max(0, pair.expires - this.now()),
            },
          }
        : {}),
      grants: [...this.grants.values()].map(publicGrant),
    };
  }

  pair(owner: string, ifAbsent = false) {
    if (this.closed) throw new DomainError('web_disabled', '服务端尚未启用 Web 访问。');
    this.expire();
    const existing = [...this.pairs.values()].find((pair) => pair.owner === owner);
    // Checking and creating stay synchronous. Reopening settings or two connections of the same
    // desktop must not rotate a code that another browser may already be redeeming.
    if (ifAbsent && existing)
      return {
        code: existing.code,
        expiresAt: existing.expiresAt,
        remainingMs: Math.max(0, existing.expires - this.now()),
      };
    if (this.grants.size >= MAX_GRANTS)
      throw new DomainError('web_limit', '已配对浏览器数量已达上限，请先撤销旧登录。');
    for (const [key, pair] of this.pairs) if (pair.owner === owner) this.pairs.delete(key);
    if (this.pairs.size >= MAX_PAIRS)
      throw new DomainError('web_limit', '正在等待配对的请求过多，请稍后再试。');
    const code = randomBytes(12).toString('hex');
    const expires = this.now() + PAIR_MS;
    const expiresAt = new Date(this.wallNow() + PAIR_MS).toISOString();
    this.pairs.set(hash(code), { owner, code, expires, expiresAt });
    this.scheduleExpiry();
    this.changed();
    return { code, expiresAt, remainingMs: PAIR_MS };
  }

  revoke(id: string) {
    if (!this.grants.has(id)) return;
    const next = new Map(this.grants);
    next.delete(id);
    this.save(next);
    this.grants = next;
    this.disconnect(id);
    this.changed();
  }

  private cookie(secret: string, lifetime = COOKIE_MS) {
    return `${this.cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetime / 1000)}${this.url.protocol === 'https:' ? '; Secure' : ''}`;
  }

  trusted(request: IncomingMessage, requireOrigin = false) {
    return (
      request.headers.host === this.url.host &&
      ((!requireOrigin && !request.headers.origin) || request.headers.origin === this.origin) &&
      (!request.headers['sec-fetch-site'] ||
        ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))
    );
  }

  private secret(request: IncomingMessage) {
    const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
    const matches = cookies.filter((part) => part.startsWith(`${this.cookieName}=`));
    if (matches.length !== 1) return undefined;
    const secret = matches[0].slice(this.cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(secret) ? secret : undefined;
  }

  authenticate(request: IncomingMessage) {
    if (this.closed) return undefined;
    const secret = this.secret(request);
    if (!secret) return undefined;
    const digest = hash(secret);
    return [...this.grants.values()].find((grant) => grant.secretHash === digest);
  }

  active(id: string) {
    this.expire();
    return !this.closed && this.grants.has(id);
  }

  attach(grant: WebGrant, socket: WebSocket) {
    if (!this.active(grant.id)) return false;
    const own = this.sockets.get(grant.id) ?? new Set<WebSocket>();
    if (own.size >= 8 || [...this.sockets.values()].reduce((sum, set) => sum + set.size, 0) >= 128)
      return false;
    own.add(socket);
    this.sockets.set(grant.id, own);
    socket.once('close', () => {
      own.delete(socket);
      if (!own.size) this.sockets.delete(grant.id);
    });
    return true;
  }

  private session(grant: WebGrant) {
    return { device: { id: grant.id, name: grant.name }, expiresAt: grant.expiresAt };
  }

  private json(response: ServerResponse, status: number, body: object) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  private async pairRequest(request: IncomingMessage, response: ServerResponse, address: string) {
    const failure = this.failures.get(address);
    if (failure && failure.count >= 6 && failure.until > this.now()) {
      response.setHeader('Retry-After', Math.ceil((failure.until - this.now()) / 1000));
      this.json(response, 429, { error: '尝试次数过多，请稍后再试。' });
      return;
    }
    const own = this.pending.get(address) ?? 0;
    if (own >= 4 || [...this.pending.values()].reduce((sum, count) => sum + count, 0) >= 32) {
      this.json(response, 429, { error: '请求过多，请稍后再试。' });
      return;
    }
    this.pending.set(address, own + 1);
    const timer = setTimeout(() => request.destroy(), 5000);
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        this.json(response, 415, { error: '请使用 JSON 请求。' });
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 1024) {
          this.json(response, 413, { error: '请求过大。' });
          return;
        }
      }
      // A disable may happen while a request body is arriving. That old instance must never issue a
      // grant after a new instance has started, even when the submitted code used to be valid.
      if (this.closed) {
        this.json(response, 503, { error: 'Web 访问已关闭，请稍后重试。' });
        return;
      }
      let input: { code: string };
      try {
        input = z
          .object({ code: z.string().regex(/^[a-f0-9]{24}$/) })
          .strict()
          .parse(JSON.parse(body));
      } catch {
        this.fail(address);
        this.json(response, 400, { error: '配对码格式不正确。' });
        return;
      }
      this.expire();
      const key = hash(input.code);
      if (!this.pairs.has(key)) {
        this.fail(address);
        this.json(response, 401, { error: '配对码已失效，请在桌面端生成新的配对码。' });
        return;
      }
      if (this.grants.size >= MAX_GRANTS) {
        this.json(response, 409, { error: '已配对浏览器数量已达上限。' });
        return;
      }
      // There is no await between consuming a code and storing its grant. Concurrent exchanges cannot both
      // succeed; an unsuccessful disk write leaves the code available for another attempt.
      const secret = randomBytes(32).toString('hex');
      const now = this.wallNow();
      const grant: WebGrant = {
        id: randomUUID(),
        name: browserName(request.headers['user-agent'] ?? ''),
        createdAt: new Date(now).toISOString(),
        expiresAt: null,
        secretHash: hash(secret),
      };
      const next = new Map(this.grants).set(grant.id, grant);
      this.save(next);
      this.grants = next;
      this.pairs.delete(key);
      this.scheduleExpiry();
      this.failures.delete(address);
      this.changed();
      response.setHeader('Set-Cookie', this.cookie(secret));
      this.json(response, 200, this.session(grant));
    } finally {
      clearTimeout(timer);
      const count = this.pending.get(address) ?? 1;
      if (count <= 1) this.pending.delete(address);
      else this.pending.set(address, count - 1);
    }
  }

  private fail(address: string) {
    if (this.failures.size >= 4096 && !this.failures.has(address))
      this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(address, {
      count: (this.failures.get(address)?.count ?? 0) + 1,
      until: this.now() + 60_000,
    });
  }

  async handle(request: IncomingMessage, response: ServerResponse, address: string) {
    if (this.closed) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    // Public assets carry no authority. A link followed from another site must load the entry page;
    // cookie-authenticated APIs and WebSockets still require the exact origin and fetch-site checks.
    const pathname = request.url?.split('?')[0] ?? '';
    const publicAsset =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (pathname === '/' ||
        pathname === '/favicon.ico' ||
        /^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|png|svg|woff2?|ttf)$/.test(pathname));
    if (
      request.headers.host !== this.url.host ||
      (!publicAsset && !this.trusted(request, request.method === 'POST'))
    ) {
      this.json(response, 403, { error: '请求来源不匹配。' });
      return;
    }
    if (request.url === '/web/pair' && request.method === 'POST') {
      await this.pairRequest(request, response, address);
      return;
    }
    if (
      (request.url === '/web/session' && request.method === 'GET') ||
      (request.url === '/web/logout' && request.method === 'POST')
    ) {
      const grant = this.authenticate(request);
      if (!grant) {
        this.json(response, 401, { error: '请先配对登录。' });
        return;
      }
      if (request.url === '/web/logout') {
        this.revoke(grant.id);
        response.setHeader('Set-Cookie', this.cookie('', 0));
        this.json(response, 200, { ok: true });
      } else {
        response.setHeader('Set-Cookie', this.cookie(this.secret(request)!));
        this.json(response, 200, this.session(grant));
      }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(404).end();
      return;
    }
    // Only generated assets and the entry page are public. No source maps, configuration files, data files
    // or SPA fallbacks for unknown API paths. Resolve symlinks before checking containment.
    if (
      pathname !== '/' &&
      pathname !== '/favicon.ico' &&
      !/^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|png|svg|woff2?|ttf)$/.test(pathname)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (this.serving >= 32) {
      response.writeHead(503, { 'Retry-After': '1' }).end();
      return;
    }
    this.serving++;
    try {
      const root = await realpath(this.directory);
      const file = await realpath(join(root, pathname === '/' ? 'index.html' : pathname.slice(1)));
      const inside = relative(root, file);
      if (
        !inside ||
        isAbsolute(inside) ||
        inside === '..' ||
        inside.startsWith(`..\\`) ||
        inside.startsWith('../')
      ) {
        response.writeHead(404).end();
        return;
      }
      const info = await stat(file);
      if (this.closed || !info.isFile() || info.size > 16 * 1024 * 1024) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(file), response);
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(404).end();
    } finally {
      this.serving--;
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of this.sockets.keys()) this.disconnect(id, true);
    this.pairs.clear();
    this.failures.clear();
  }
}
