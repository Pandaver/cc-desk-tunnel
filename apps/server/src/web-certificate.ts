import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { connect, createSecureContext, TLSSocket } from 'node:tls';
import type { SecureContext } from 'node:tls';
import { z } from 'zod';
import {
  WEB_CERTIFICATE_LIMIT,
  WEB_PRIVATE_KEY_LIMIT,
  webDomainSchema,
} from '@cc-desk-tunnel/protocol';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';

const materialSchema = z
  .object({
    domain: webDomainSchema.refine(Boolean),
    cert: z.string().min(1).max(WEB_CERTIFICATE_LIMIT),
    key: z.string().min(1).max(WEB_PRIVATE_KEY_LIMIT),
  })
  .strict();
type Material = z.infer<typeof materialSchema>;
const storageSchema = z
  .object({
    revision: z.uuid(),
    current: materialSchema.nullable(),
    previous: materialSchema.nullable(),
  })
  .strict();
type Storage = z.infer<typeof storageSchema>;
const MAX_STORAGE_BYTES = 12 * (WEB_CERTIFICATE_LIMIT + WEB_PRIVATE_KEY_LIMIT) + 4096;
const invalid = (message: string): never => {
  throw new DomainError('web_certificate_invalid', message);
};

// X509Certificate.keyUsage exposes extended purposes, not the basic KeyUsage extension. Read only
// the bounded DER containers on the path to extensions; OpenSSL already parsed this certificate.
function keyUsage(certificate: X509Certificate): Buffer | undefined {
  type Element = { tag: number; value: Buffer };
  function elements(bytes: Buffer): Element[] {
    const result: Element[] = [];
    for (let offset = 0; offset < bytes.length;) {
      if (bytes.length - offset < 2) throw new Error('Invalid DER');
      const tag = bytes[offset++];
      let length = bytes[offset++];
      if (length & 0x80) {
        const count = length & 0x7f;
        if (!count || count > 4 || count > bytes.length - offset || bytes[offset] === 0)
          throw new Error('Invalid DER');
        length = 0;
        for (let index = 0; index < count; index++) length = length * 256 + bytes[offset++];
        if (length < 128) throw new Error('Invalid DER');
      }
      if (length > bytes.length - offset) throw new Error('Invalid DER');
      result.push({ tag, value: bytes.subarray(offset, offset + length) });
      offset += length;
    }
    return result;
  }
  const root = elements(certificate.raw);
  if (root.length !== 1 || root[0].tag !== 0x30) throw new Error('Invalid DER');
  const body = elements(root[0].value)[0];
  if (body?.tag !== 0x30) throw new Error('Invalid DER');
  const extensions = elements(body.value).filter((entry) => entry.tag === 0xa3);
  if (!extensions.length) return;
  if (extensions.length !== 1) throw new Error('Invalid DER');
  const sequence = elements(extensions[0].value);
  if (sequence.length !== 1 || sequence[0].tag !== 0x30) throw new Error('Invalid DER');
  let usage: Buffer | undefined;
  const seen = new Set<string>();
  for (const extension of elements(sequence[0].value)) {
    if (extension.tag !== 0x30) throw new Error('Invalid DER');
    const fields = elements(extension.value);
    if (
      (fields.length !== 2 && fields.length !== 3) ||
      fields[0].tag !== 0x06 ||
      fields.at(-1)!.tag !== 0x04
    )
      throw new Error('Invalid DER');
    if (
      fields.length === 3 &&
      (fields[1].tag !== 0x01 ||
        fields[1].value.length !== 1 ||
        ![0, 255].includes(fields[1].value[0]))
    )
      throw new Error('Invalid DER');
    const oid = fields[0].value.toString('hex');
    if (seen.has(oid)) throw new Error('Duplicate certificate extension');
    seen.add(oid);
    if (oid !== '551d0f') continue;
    const bits = elements(fields.at(-1)!.value);
    if (
      bits.length !== 1 ||
      bits[0].tag !== 0x03 ||
      bits[0].value.length < 2 ||
      bits[0].value.length > 3
    )
      throw new Error('Invalid KeyUsage');
    const unused = bits[0].value[0];
    if (unused > 7 || bits[0].value.at(-1)! & ((1 << unused) - 1))
      throw new Error('Invalid KeyUsage');
    usage = bits[0].value.subarray(1);
  }
  return usage;
}

// Validate a conventional fullchain (leaf first, then issuing intermediates; the root is optional).
// Parsing errors are deliberately replaced: OpenSSL errors can contain submitted key material.
function validate(material: Material) {
  const parsed = materialSchema.safeParse(material);
  if (!parsed.success) invalid('证书、私钥或访问域名格式无效，或内容过长。');
  const { cert, key, domain } = parsed.data!;
  if (
    Buffer.byteLength(cert) > WEB_CERTIFICATE_LIMIT ||
    Buffer.byteLength(key) > WEB_PRIVATE_KEY_LIMIT
  )
    invalid('证书或私钥内容过长。');
  const blocks = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (
    !blocks.length ||
    blocks.length > 16 ||
    cert.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
  )
    invalid('请填写 PEM 证书链，服务器证书在前，随后为签发它的中间证书。');
  if (
    !/^\s*-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----[A-Za-z0-9+/=\s]+-----END \1-----\s*$/.test(
      key,
    )
  )
    invalid('请填写未加密的 PEM 私钥。');
  try {
    const chain = blocks.map((pem) => new X509Certificate(pem));
    const leaf = chain[0];
    const now = Date.now();
    if (
      chain.some(
        (entry) =>
          !Number.isFinite(Date.parse(entry.validFrom)) ||
          !Number.isFinite(Date.parse(entry.validTo)) ||
          Date.parse(entry.validFrom) > now ||
          Date.parse(entry.validTo) <= now,
      )
    )
      invalid('证书链包含尚未生效或已过期的证书。');
    if (leaf.ca) invalid('请填写服务器证书，而不是 CA 证书。');
    const usage = keyUsage(leaf);
    if (usage && !(usage[0] & 0x80)) invalid('服务器证书的密钥用途不允许 TLS 数字签名。');
    if (
      chain.some((entry) => entry.keyUsage?.length && !entry.keyUsage.includes('1.3.6.1.5.5.7.3.1'))
    )
      invalid('证书链用途不包含 TLS 服务器认证。');
    if (!leaf.checkHost(domain, { subject: 'never' })) invalid('证书未覆盖当前访问域名。');
    if (!leaf.checkPrivateKey(createPrivateKey(key))) invalid('证书与私钥不匹配。');
    const seen = new Set<string>();
    for (let index = 0; index < chain.length; index++) {
      const entry = chain[index];
      if (seen.has(entry.fingerprint256)) invalid('证书链包含重复证书。');
      seen.add(entry.fingerprint256);
      if (entry.checkIssued(entry) && !entry.verify(entry.publicKey))
        invalid('证书链包含无效的自签证书。');
      if (index + 1 < chain.length) {
        const issuer = chain[index + 1];
        if (!issuer.ca || !entry.checkIssued(issuer) || !entry.verify(issuer.publicKey))
          invalid('证书链顺序或签名无效，请按服务器证书、中间证书顺序填写。');
      }
    }
    return {
      material: { domain, cert, key },
      context: createSecureContext({ cert, key }),
      // The last supplied CA anchors only this validation. It is not added to system trust.
      // Partial chains are conventional fullchains that omit their root certificate.
      anchor:
        chain.at(-1)!.ca ||
        (chain.at(-1)!.issuer === chain.at(-1)!.subject &&
          chain.at(-1)!.verify(chain.at(-1)!.publicKey))
          ? blocks.at(-1)
          : undefined,
      details: {
        domain,
        subject: leaf.subject,
        issuer: leaf.issuer,
        validFrom: new Date(leaf.validFrom).toISOString(),
        validTo: new Date(leaf.validTo).toISOString(),
        fingerprint: leaf.fingerprint256,
      },
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return invalid('证书或私钥无法解析，请检查 PEM 格式及证书链。');
  }
}

type Validated = ReturnType<typeof validate>;
const conflict = () =>
  new DomainError('web_certificate_conflict', '证书配置已发生变化，请刷新后重试。');

// OpenSSL validates constraints across the whole chain, not just adjacent signatures. Use an
// in-memory TLS handshake so imports need no external process, DNS lookup or listening port.
// This proves the supplied chain is usable, not that a browser trusts its private/custom CA.
function verifyChain(active: Validated, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(conflict());
    let settled = false;
    let server: TLSSocket | undefined;
    let client: TLSSocket | undefined;
    let serverTransport: Duplex;
    let clientTransport: Duplex;
    const invalidChain = () =>
      new DomainError(
        'web_certificate_invalid',
        '证书链无法通过 TLS 验证，请检查完整证书链、证书约束及用途。',
      );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      client?.destroy();
      server?.destroy();
      clientTransport?.destroy();
      serverTransport?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish(conflict());
    const timer = setTimeout(
      () =>
        finish(new DomainError('web_certificate_invalid', '证书链 TLS 验证超时，原证书保持不变。')),
      5000,
    );
    signal.addEventListener('abort', cancel, { once: true });
    try {
      serverTransport = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          clientTransport.push(chunk);
          callback();
        },
      });
      clientTransport = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          serverTransport.push(chunk);
          callback();
        },
      });
      serverTransport.on('error', () => finish(invalidChain()));
      clientTransport.on('error', () => finish(invalidChain()));
      server = new TLSSocket(serverTransport, { isServer: true, secureContext: active.context });
      server.on('error', () => finish(invalidChain()));
      server.on('close', () => finish(invalidChain()));
      client = connect({
        socket: clientTransport,
        servername: active.material.domain,
        rejectUnauthorized: true,
        ...(active.anchor ? { ca: active.anchor, allowPartialTrustChain: true } : {}),
      });
      client.on('error', () => finish(invalidChain()));
      client.on('close', () => finish(invalidChain()));
      client.once('secureConnect', () => finish());
    } catch {
      finish(invalidChain());
    }
  });
}

// SNI identity belongs to the listener, not to the optional HTTP surface. Closing Web must not
// change the certificate used by a desktop connected to the same domain. With no saved material,
// construction reads only: it creates no directory, timer or new listener.
export class WebCertificates {
  private file: string;
  private mode: 'local' | 'external' | 'unavailable';
  private saved: Storage = { revision: randomUUID(), current: null, previous: null };
  private active?: Validated;
  private error?: string;
  private initialization?: Promise<void>;
  private generation = 0;
  private pending = new Set<AbortController>();

  constructor(dataDir: string, transport: { tls?: boolean; reverseProxy?: boolean }) {
    this.file = join(dataDir, 'web-access', 'certificate.json');
    this.mode = transport.reverseProxy ? 'external' : transport.tls ? 'local' : 'unavailable';
    if (this.mode !== 'local') return;
    try {
      if (statSync(this.file).size > MAX_STORAGE_BYTES) throw new Error('Oversized storage');
      const saved = storageSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.saved = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.error = '自定义证书存储无效或证书已失效，当前使用原默认证书。请恢复默认后重新导入。';
    }
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.mode !== 'local' || this.error || !this.saved.current)
      return (this.initialization = Promise.resolve());
    const generation = this.generation;
    const material = this.saved.current;
    const controller = new AbortController();
    this.pending.add(controller);
    this.initialization = (async () => {
      try {
        const active = validate(material);
        await verifyChain(active, controller.signal);
        if (generation === this.generation) this.active = active;
      } catch {
        if (generation === this.generation)
          this.error = '自定义证书存储无效或证书已失效，当前使用原默认证书。请恢复默认后重新导入。';
      } finally {
        this.pending.delete(controller);
      }
    })();
    return this.initialization;
  }

  state(): WebCertificateState {
    if (this.mode === 'external')
      return { mode: 'external', revision: '', error: 'HTTPS 证书由外部反向代理管理。' };
    if (this.mode === 'unavailable')
      return { mode: 'unavailable', revision: '', error: '当前服务未直接启用 TLS。' };
    if (this.error)
      return { mode: 'unavailable', revision: this.saved.revision, error: this.error };
    return {
      mode: this.active ? 'custom' : 'default',
      revision: this.saved.revision,
      ...(this.active ? { details: this.active.details } : {}),
    };
  }

  context(servername: string): SecureContext | undefined {
    return this.saved.current?.domain === servername.toLowerCase()
      ? this.active?.context
      : undefined;
  }

  validateDomain(domain: string) {
    if (this.saved.current && this.saved.current.domain !== domain)
      throw new DomainError('web_certificate_domain', '请先将证书恢复默认，再修改访问域名。');
  }

  private check(revision: string) {
    if (this.mode !== 'local')
      throw new DomainError('web_certificate_unavailable', this.state().error!);
    if (revision !== this.saved.revision) throw conflict();
  }

  private save(current: Material | null) {
    const saved: Storage = { revision: randomUUID(), current, previous: this.saved.current };
    const directory = join(this.file, '..');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const descriptor = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(saved));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.file);
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the original failure. */
      }
      throw new DomainError('web_certificate_save_failed', '证书保存失败，原证书保持不变。');
    }
    this.saved = saved;
    this.error = undefined;
  }

  async set(revision: string, material: Material, beforeCommit?: () => void) {
    this.check(revision);
    const generation = this.generation;
    await this.initialize();
    this.check(revision);
    if (generation !== this.generation) throw conflict();
    if (this.error) throw new DomainError('web_certificate_unavailable', this.error);
    if (this.pending.size >= 4)
      throw new DomainError('web_certificate_busy', '证书校验正在进行，请稍后重试。');
    const active = validate(material);
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      await verifyChain(active, controller.signal);
      this.check(revision);
      if (generation !== this.generation) throw conflict();
      beforeCommit?.();
      // Validation and caller checks finish before the synchronous atomic commit. No await can
      // let a competing import, reset, domain change or listener shutdown slip into this interval.
      this.save(active.material);
      this.active = active;
      this.invalidate();
    } finally {
      this.pending.delete(controller);
    }
  }

  private invalidate() {
    this.generation++;
    for (const controller of this.pending) controller.abort();
  }

  reset(revision: string) {
    this.check(revision);
    // Even an already-default reset cancels in-flight uploads and startup validation.
    if (this.saved.current || this.error) this.save(null);
    this.invalidate();
    this.active = undefined;
  }
}
