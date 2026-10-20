import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  webCommandSchema,
  webLoginSchema,
  webStoredSettingsSchema,
} from '@cc-desk-tunnel/protocol';
import type {
  WebCommand,
  WebLoginState,
  WebProof,
  WebSession,
  WebSettingsState,
} from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { Throttle } from './throttle.ts';
import { totpSecret, totpStep } from './web-totp.ts';

const DAY = 86_400_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const defaults = {
  enabled: false,
  domain: '',
  path: '',
  idleMinutes: 120,
  proxyEnabled: false,
  trustedProxies: [] as string[],
};
type Settings = typeof defaults;
type StoredSession = {
  id: string;
  secret_hash: string;
  token_hash: string;
  name: string;
  created: number;
  active: number;
  expires: number;
};
type StoredSettings = {
  settings: string;
  device_id: string;
  totp_secret: string | null;
  totp_last: number;
  pending_secret: string | null;
  pending_expires: number | null;
};
export type WebAccessOptions = {
  database: DatabaseSync;
  token: string;
  directory: string;
  tls: boolean;
  reverseProxy?: boolean;
  host?: string;
  throttle: Throttle;
  now?: () => number;
  selfSigned?: (hostname: string) => boolean;
  validateDomain?: (domain: string) => void;
};
export type WebContext = { desktop: boolean; address: string; sessionId?: string; origin?: string };
const ip = (address: string) =>
  address.startsWith('::ffff:') && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : isIP(address) === 6
      ? new URL(`http://[${address}]`).hostname.slice(1, -1)
      : address;
const loopback = (address: string) => address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address);
const fail = (code: string, message: string): never => {
  throw new DomainError(code, message);
};

export function webStaticPath(root: string, target: string) {
  const inside = relative(root, target);
  return !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`);
}

export class WebAccess {
  private options: WebAccessOptions;
  private settings: Settings;
  private tokenHash: string;
  private now: () => number;
  private sockets = new Map<string, Set<WebSocket>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private serving = 0;
  readonly serverDeviceId: string;

  constructor(options: WebAccessOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.tokenHash = hash(options.token);
    options.database.exec(`
      CREATE TABLE IF NOT EXISTS web_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, device_id TEXT NOT NULL,
        totp_secret TEXT, totp_last INTEGER NOT NULL DEFAULT -1, pending_secret TEXT, pending_expires INTEGER
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
        name TEXT NOT NULL, created INTEGER NOT NULL, active INTEGER NOT NULL, expires INTEGER NOT NULL
      );
    `);
    options.database
      .prepare('INSERT OR IGNORE INTO web_settings (id, settings, device_id) VALUES (1, ?, ?)')
      .run(JSON.stringify(defaults), randomUUID());
    const row = this.record();
    this.settings = webStoredSettingsSchema.parse(JSON.parse(row.settings));
    this.serverDeviceId = z.uuid().parse(row.device_id);
    options.database.prepare('DELETE FROM web_sessions WHERE token_hash != ?').run(this.tokenHash);
    this.sweep();
  }

  private record() {
    return this.options.database
      .prepare('SELECT * FROM web_settings WHERE id = 1')
      .get() as StoredSettings;
  }
  get enabled() {
    return !this.closed && this.settings.enabled;
  }
  get domain() {
    return this.settings.domain;
  }
  private get prefix() {
    return this.settings.path ? `/${this.settings.path}` : '';
  }
  private get cookieName() {
    return `cc_web_${this.serverDeviceId.replaceAll('-', '')}_${hash(this.prefix).slice(0, 16)}`;
  }
  private publicSession(row: StoredSession): WebSession {
    return {
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created).toISOString(),
      lastActiveAt: new Date(row.active).toISOString(),
      expiresAt: new Date(row.expires).toISOString(),
    };
  }
  private getSession(id: string) {
    return this.options.database.prepare('SELECT * FROM web_sessions WHERE id = ?').get(id) as
      StoredSession | undefined;
  }
  private valid(row: StoredSession) {
    const now = this.now();
    return (
      row.token_hash === this.tokenHash &&
      row.expires > now &&
      row.active + this.settings.idleMinutes * 60_000 > now
    );
  }
  private disconnect(id: string) {
    for (const socket of this.sockets.get(id) ?? []) socket.close(4001, 'Browser session ended');
    this.sockets.delete(id);
  }
  private revoke(id: string) {
    this.options.database.prepare('DELETE FROM web_sessions WHERE id = ?').run(id);
    this.disconnect(id);
  }
  private sweep() {
    const rows = this.options.database
      .prepare('SELECT * FROM web_sessions')
      .all() as StoredSession[];
    for (const row of rows) if (!this.valid(row)) this.revoke(row.id);
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled || !this.sockets.size) return;
    let next = Infinity;
    for (const id of this.sockets.keys()) {
      const row = this.getSession(id);
      if (row) next = Math.min(next, row.expires, row.active + this.settings.idleMinutes * 60_000);
    }
    if (Number.isFinite(next)) {
      this.timer = setTimeout(
        () => {
          this.sweep();
          this.schedule();
        },
        Math.max(1, Math.min(next - this.now(), 2_147_483_647)),
      );
      this.timer.unref();
    }
  }
  active(id: string) {
    if (!this.enabled) return false;
    const row = this.getSession(id);
    if (row && this.valid(row)) return true;
    if (row) this.revoke(id);
    return false;
  }
  touch(id: string) {
    if (!this.active(id)) return false;
    this.options.database
      .prepare('UPDATE web_sessions SET active = ? WHERE id = ?')
      .run(this.now(), id);
    this.schedule();
    return true;
  }
  attach(id: string, socket: WebSocket) {
    if (!this.active(id)) return false;
    const own = this.sockets.get(id) ?? new Set<WebSocket>();
    if (
      own.size >= 8 ||
      [...this.sockets.values()].reduce((sum, value) => sum + value.size, 0) >= 128
    )
      return false;
    own.add(socket);
    this.sockets.set(id, own);
    socket.once('close', () => {
      own.delete(socket);
      if (!own.size && this.sockets.get(id) === own) this.sockets.delete(id);
      this.schedule();
    });
    this.schedule();
    return true;
  }

  address(request: IncomingMessage) {
    const remote = ip(request.socket.remoteAddress ?? '');
    const trusted =
      this.options.reverseProxy ||
      (this.settings.proxyEnabled && this.settings.trustedProxies.includes(remote));
    const forwarded = request.headers['x-real-ip'];
    return trusted && typeof forwarded === 'string' && isIP(forwarded) ? ip(forwarded) : remote;
  }
  private requestOrigin(request: IncomingMessage) {
    const host = request.headers.host;
    if (!host || /[\s,/@\\?#]/.test(host)) return undefined;
    const protocol = this.options.tls || this.options.reverseProxy ? 'https:' : 'http:';
    try {
      const url = new URL(`${protocol}//${host}`);
      if (this.settings.domain && url.hostname !== this.settings.domain) return undefined;
      if (
        protocol === 'http:' &&
        (!loopback(ip(request.socket.remoteAddress ?? '')) ||
          !loopback(this.options.host ?? '127.0.0.1') ||
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  }
  private trusted(request: IncomingMessage, required = true) {
    const origin = this.requestOrigin(request);
    return (
      !!origin &&
      (request.headers.origin === origin ||
        (!required &&
          !request.headers.origin &&
          (!request.headers['sec-fetch-site'] ||
            ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))))
    );
  }
  private route(request: IncomingMessage) {
    const raw = request.url ?? '';
    const pathname = raw.split('?')[0];
    if (!pathname.startsWith(`${this.prefix}/`)) return undefined;
    return pathname.slice(this.prefix.length);
  }
  matchesUpgrade(request: IncomingMessage) {
    return this.enabled && this.route(request) === '/api/ws' && !!this.requestOrigin(request);
  }
  authenticate(request: IncomingMessage) {
    if (!this.enabled || !this.trusted(request)) return undefined;
    const row = this.cookieSession(request);
    return row ? this.publicSession(row) : undefined;
  }
  private cookieSession(request: IncomingMessage) {
    const values = (request.headers.cookie ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return undefined;
    const secret = values[0].slice(this.cookieName.length + 1);
    if (!/^[a-f0-9]{64}$/.test(secret)) return undefined;
    const row = this.options.database
      .prepare('SELECT * FROM web_sessions WHERE secret_hash = ?')
      .get(hash(secret)) as StoredSession | undefined;
    if (!row || !this.active(row.id)) return undefined;
    return row;
  }
  private cookie(secret: string, expiry: number) {
    const secure = this.options.tls || this.options.reverseProxy;
    return `${this.cookieName}=${secret}; Path=${this.prefix}/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiry - this.now()) / 1000))}${secure ? '; Secure' : ''}`;
  }
  private url(origin?: string) {
    if (!origin) return undefined;
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        return undefined;
      if (this.settings.domain) url.hostname = this.settings.domain;
      url.pathname = `${this.prefix}/`;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return undefined;
    }
  }
  private selfSigned(origin?: string) {
    return (
      this.options.selfSigned?.(origin ? new URL(origin).hostname : this.settings.domain) ?? false
    );
  }
  state(origin?: string): WebSettingsState {
    this.sweep();
    return {
      ...this.settings,
      totpEnabled: !!this.record().totp_secret,
      sessions: (
        this.options.database
          .prepare('SELECT * FROM web_sessions ORDER BY created DESC')
          .all() as StoredSession[]
      ).map((row) => this.publicSession(row)),
      url: this.url(origin),
      selfSigned: this.selfSigned(this.url(origin)),
    };
  }
  private loginState(request: IncomingMessage, row?: StoredSession): WebLoginState {
    return {
      authenticated: !!row,
      ...(row ? { session: this.publicSession(row) } : {}),
      totpEnabled: !!this.record().totp_secret,
      selfSigned: this.selfSigned(this.requestOrigin(request)),
      url: this.url(this.requestOrigin(request)),
    };
  }
  private proof(proof: WebProof | undefined, address: string, succeed = true) {
    if (this.options.throttle.blocked(address, this.now()))
      fail('web_rate_limited', '尝试过于频繁，请稍后重试。');
    const row = this.record();
    const passwordOK =
      proof &&
      timingSafeEqual(Buffer.from(hash(proof.password), 'hex'), Buffer.from(this.tokenHash, 'hex'));
    const step = row.totp_secret
      ? totpStep(row.totp_secret, proof?.code ?? '', this.now(), row.totp_last)
      : undefined;
    if (!passwordOK || (row.totp_secret && step === undefined)) {
      this.options.throttle.fail(address, this.now());
      fail('web_unauthorized', '密码或动态码不正确，或动态码已被使用。');
    }
    if (step !== undefined)
      this.options.database.prepare('UPDATE web_settings SET totp_last = ? WHERE id = 1').run(step);
    if (succeed) this.options.throttle.succeed(address);
  }
  execute(input: WebCommand, context: WebContext) {
    const command = webCommandSchema.parse(input);
    if (!context.desktop && (!context.sessionId || !this.active(context.sessionId)))
      fail('web_unauthorized', '登录已失效，请重新登录。');
    if (command.type === 'web.settings.get') return this.state(context.origin);
    if (command.type === 'web.settings.update') {
      const values = command.values;
      if ('enabled' in values && !context.desktop)
        fail('web_desktop_only', '请在桌面客户端启停 Web。');
      if (!context.desktop && Object.keys(values).some((key) => key !== 'path'))
        fail('web_desktop_only', '此设置需要在桌面客户端修改。');
      if (!context.desktop && Object.keys(values).some((key) => key !== 'enabled'))
        this.proof(command.proof, context.address);
      const next = { ...this.settings, ...values };
      this.options.validateDomain?.(next.domain);
      const proxies = next.trustedProxies.map(ip);
      if (proxies.some((value) => !isIP(value)) || (next.proxyEnabled && !proxies.length))
        fail('web_invalid_settings', '请填写可信反向代理的 IP 地址。');
      if (
        next.enabled &&
        !this.options.tls &&
        !this.options.reverseProxy &&
        !loopback(this.options.host ?? '127.0.0.1')
      )
        fail('web_https_required', '公网 Web 访问需要 HTTPS。');
      if (next.domain && !this.options.tls && !this.options.reverseProxy)
        fail('web_https_required', '域名访问需要 HTTPS。');
      next.trustedProxies = [...new Set(proxies)];
      const moved = next.domain !== this.settings.domain || next.path !== this.settings.path;
      this.options.database
        .prepare('UPDATE web_settings SET settings = ? WHERE id = 1')
        .run(JSON.stringify(next));
      this.settings = next;
      if (moved) this.options.database.prepare('DELETE FROM web_sessions').run();
      if (moved || !next.enabled) {
        const ids = [...this.sockets.keys()];
        setImmediate(() => {
          for (const id of ids) this.disconnect(id);
          this.schedule();
        });
      }
      this.sweep();
      this.schedule();
    } else if (command.type === 'web.sessions.revoke') {
      this.proof(command.proof, context.address);
      this.revoke(command.sessionId);
    } else if (command.type === 'web.totp.setup') {
      if (!context.desktop) this.proof(command.proof, context.address);
      if (this.record().totp_secret) fail('web_totp_enabled', '请先关闭现有二次验证。');
      const secret = totpSecret(),
        expires = this.now() + 600_000;
      this.options.database
        .prepare('UPDATE web_settings SET pending_secret = ?, pending_expires = ? WHERE id = 1')
        .run(secret, expires);
      return {
        secret,
        uri: `otpauth://totp/CC%20Desk%20Tunnel:${encodeURIComponent(this.settings.domain || 'Web')}?secret=${secret}&issuer=CC%20Desk%20Tunnel&algorithm=SHA1&digits=6&period=30`,
        expiresAt: new Date(expires).toISOString(),
      };
    } else if (command.type === 'web.totp.enable') {
      if (!context.desktop) this.proof(command.proof, context.address, false);
      else if (this.options.throttle.blocked(context.address, this.now()))
        fail('web_rate_limited', '尝试过于频繁，请稍后重试。');
      const row = this.record();
      const step =
        row.pending_secret && row.pending_expires! > this.now()
          ? totpStep(row.pending_secret, command.code, this.now(), -1)
          : undefined;
      if (step === undefined) {
        this.options.throttle.fail(context.address, this.now());
        fail('web_totp_invalid', '动态码不正确或设置已过期，请重新设置。');
      }
      this.options.database
        .prepare(
          'UPDATE web_settings SET totp_secret = pending_secret, totp_last = ?, pending_secret = NULL, pending_expires = NULL WHERE id = 1',
        )
        .run(step!);
      this.options.throttle.succeed(context.address);
      this.clearSessions(context.sessionId);
    } else if (command.type === 'web.totp.disable') {
      if (!context.desktop) this.proof(command.proof, context.address);
      this.options.database
        .prepare(
          'UPDATE web_settings SET totp_secret = NULL, totp_last = -1, pending_secret = NULL, pending_expires = NULL WHERE id = 1',
        )
        .run();
      this.clearSessions(context.sessionId);
    }
    return this.state(context.origin);
  }
  private clearSessions(except?: string) {
    const rows = this.options.database.prepare('SELECT id FROM web_sessions').all() as {
      id: string;
    }[];
    for (const row of rows) if (row.id !== except) this.revoke(row.id);
  }
  private headers(response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (this.options.tls || this.options.reverseProxy)
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  private json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }
  private async body(request: IncomingMessage) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? '')))
      fail('web_bad_request', '请使用 JSON 请求。');
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => request.destroy(), 10_000);
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) fail('web_bad_request', '请求内容过长。');
        chunks.push(Buffer.from(chunk));
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail('web_bad_request', '请求格式无效。');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!this.enabled) return false;
    this.headers(response);
    if (
      this.enabled &&
      this.prefix &&
      (request.url ?? '').split('?')[0] === this.prefix &&
      ['GET', 'HEAD'].includes(request.method ?? '') &&
      this.requestOrigin(request)
    ) {
      response.writeHead(308, { Location: `${this.prefix}/` }).end();
      return true;
    }
    const route = this.route(request);
    if (!this.enabled || !route || !this.requestOrigin(request)) {
      response.writeHead(404).end();
      return true;
    }
    if (route.startsWith('/api/')) {
      if (!this.trusted(request, request.method !== 'GET')) {
        response.writeHead(403).end();
        return true;
      }
      if (route === '/api/session' && request.method === 'GET') {
        this.json(response, 200, this.loginState(request, this.cookieSession(request)));
        return true;
      }
      if (route === '/api/logout' && request.method === 'POST') {
        const row = this.cookieSession(request);
        if (row) this.revoke(row.id);
        response.setHeader('Set-Cookie', this.cookie('', 0));
        this.json(response, 200, { authenticated: false });
        return true;
      }
      if (route !== '/api/login' || request.method !== 'POST') {
        response.writeHead(404).end();
        return true;
      }
      const address = this.address(request);
      const wait = this.options.throttle.blocked(address, this.now());
      if (wait || !this.options.throttle.enter(address)) {
        response.setHeader('Retry-After', String(wait || 5));
        this.json(response, 429, { error: '尝试过于频繁，请稍后重试。' });
        return true;
      }
      try {
        const body = webLoginSchema.safeParse(await this.body(request));
        if (!body.success) fail('web_bad_request', '登录请求格式无效。');
        if (!this.enabled || !this.requestOrigin(request) || route !== this.route(request)) {
          response.writeHead(404).end();
          return true;
        }
        this.proof(body.data, address);
        this.sweep();
        const previous = this.cookieSession(request);
        const count = this.options.database
          .prepare('SELECT COUNT(*) AS count FROM web_sessions')
          .get() as { count: number };
        if (count.count >= 128 && !previous)
          fail('web_session_limit', '登录会话数量已达上限，请先撤销不用的会话。');
        const now = this.now(),
          secret = randomBytes(32).toString('hex');
        const row: StoredSession = {
          id: randomUUID(),
          name: String(request.headers['user-agent'] ?? '浏览器').slice(0, 120),
          secret_hash: hash(secret),
          token_hash: this.tokenHash,
          created: now,
          active: now,
          expires: now + 30 * DAY,
        };
        this.options.database
          .prepare(
            'INSERT INTO web_sessions (id, secret_hash, token_hash, name, created, active, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(row.id, row.secret_hash, row.token_hash, row.name, now, now, row.expires);
        if (previous) this.revoke(previous.id);
        response.setHeader('Set-Cookie', this.cookie(secret, row.expires));
        this.json(response, 200, this.loginState(request, row));
      } catch (error) {
        const known = error instanceof DomainError;
        this.json(
          response,
          known && error.code === 'web_unauthorized'
            ? 401
            : known && error.code === 'web_rate_limited'
              ? 429
              : 400,
          {
            error: known ? error.message : '登录暂时不可用。',
            code: known ? error.code : 'web_login_failed',
          },
        );
      } finally {
        this.options.throttle.leave(address);
      }
      return true;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '') || this.serving >= 32) {
      response.writeHead(404).end();
      return true;
    }
    this.serving++;
    try {
      const file = route === '/' ? 'index.html' : decodeURIComponent(route.slice(1));
      if (
        file.includes('\\') ||
        file.includes('\0') ||
        file.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.')) ||
        file.endsWith('.map') ||
        !(
          file === 'index.html' ||
          file.startsWith('assets/') ||
          ['favicon.ico', 'icon.png'].includes(file)
        )
      ) {
        response.writeHead(404).end();
        return true;
      }
      const root = await realpath(this.options.directory),
        target = await realpath(resolve(root, file));
      if (!webStaticPath(root, target)) {
        response.writeHead(404).end();
        return true;
      }
      const info = await stat(target);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) {
        response.writeHead(404).end();
        return true;
      }
      let data = await readFile(target);
      if (file === 'index.html') {
        // The shared build carries the desktop policy; Web uses the HTTP policy above.
        data = Buffer.from(
          data
            .toString('utf8')
            .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, ''),
        );
      }
      if (!this.enabled || route !== this.route(request) || !this.requestOrigin(request)) {
        response.writeHead(404).end();
        return true;
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
      };
      response.writeHead(200, {
        'Content-Type': types[extname(target)] ?? 'application/octet-stream',
        'Content-Length': data.length,
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      if (!response.headersSent) response.writeHead(404).end();
      else response.destroy();
    } finally {
      this.serving--;
    }
    return true;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const id of this.sockets.keys()) this.disconnect(id);
  }
}
