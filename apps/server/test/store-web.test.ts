import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/store.ts';

// A deployment may retain browser authorization after its history database has been rebuilt. Web's
// storage must never be interpreted as a legacy session, whether it is valid or needs a later repair.
for (const contents of [
  JSON.stringify([
    {
      id: randomUUID(),
      name: 'Edge',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      secretHash: 'a'.repeat(64),
    },
  ]),
  '{',
]) {
  test(`legacy session import leaves ${contents === '{' ? 'invalid' : 'valid'} Web grants untouched`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-store-web-'));
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const record = {
        session: {
          id,
          title: '旧会话',
          projectPath: 'C:\\work',
          createdAt: now,
          updatedAt: now,
          activeRun: null,
        },
        events: [],
        createRequestId: randomUUID(),
      };
      writeFileSync(join(directory, `${id}.json`), JSON.stringify(record));
      const file = join(directory, 'web-grants.json');
      writeFileSync(file, contents);
      const store = new SessionStore(directory);
      try {
        assert.equal(store.list().length, 1);
        assert.equal(store.get(id).session.title, '旧会话');
        assert.equal(readFileSync(file, 'utf8'), contents);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('excluding Web storage does not suppress corrupt real legacy session records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-store-web-invalid-'));
  try {
    writeFileSync(join(directory, 'web-grants.json'), '[]');
    writeFileSync(join(directory, `${randomUUID()}.json`), '{');
    assert.throws(() => new SessionStore(directory), SyntaxError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
