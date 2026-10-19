import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSecureContext } from 'node:tls';
import { ca, custom, defaultCertificate } from './fixtures/web-certificates.ts';

test('Docker healthcheck verifies the default TLS identity even when its hostname has a custom SNI certificate', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-cert-healthcheck-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const certFile = join(directory, 'ca.pem');
  writeFileSync(certFile, defaultCertificate.cert);
  let sniRequests = 0;
  const server = createServer(
    {
      ...defaultCertificate,
      SNICallback(_name, callback) {
        sniRequests += 1;
        callback(null, createSecureContext(custom));
      },
    },
    (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', adapter: 'claude-code' }));
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const run = async (name: string, trust = certFile) => {
    const child = spawn(process.execPath, ['deploy/docker/healthcheck.mjs'], {
      env: {
        ...process.env,
        PROXY_TLS_MODE: 'direct',
        PROXY_PORT: String(address.port),
        PROXY_TLS_CERT: trust,
        PROXY_CERT_NAME: name,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    return (await once(child, 'exit'))[0];
  };
  assert.equal(await run('default.example.test'), 0);
  assert.equal(sniRequests, 0);
  assert.equal(await run('wrong.example.test'), 1, 'hostname verification must remain enabled');
  const untrusted = join(directory, 'untrusted.pem');
  writeFileSync(untrusted, ca);
  assert.equal(
    await run('default.example.test', untrusted),
    1,
    'CA verification must remain enabled',
  );
});
