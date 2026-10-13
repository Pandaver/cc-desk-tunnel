const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');

const hash = (value) => createHash('sha256').update(value).digest('hex');

// Keep both auth state and successful listener preferences atomic: a failed replacement leaves the old file.
function atomicPrivateWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink())
    throw new Error('Private storage is a symlink.');
  const temp = join(dirname(file), `.remote-${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

// Session identifiers are stored only as SHA-256 hashes; sockets and rate counters stay listener-local.
// An available OS secret store encrypts the pairing code and metadata together. The fallback is a private file.
function createWebAuthStore({ filePath, safeStorage, token, save = atomicPrivateWrite } = {}) {
  const listeners = new Set();
  const encrypted = () =>
    safeStorage?.isEncryptionAvailable() === true &&
    safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  function persist(next) {
    if (!filePath) return;
    const plain = JSON.stringify(next);
    const envelope = encrypted()
      ? {
          version: 2,
          kind: 'safe-storage',
          payload: safeStorage.encryptString(plain).toString('base64'),
        }
      : { version: 2, kind: 'private-file', payload: plain };
    save(filePath, JSON.stringify(envelope));
  }
  let state;
  if (filePath && existsSync(filePath)) {
    try {
      if (lstatSync(filePath).isSymbolicLink() || lstatSync(filePath).size > 65536)
        throw new Error();
      const envelope = JSON.parse(readFileSync(filePath, 'utf8'));
      if (envelope.version !== 2 || typeof envelope.payload !== 'string') throw new Error();
      if (envelope.kind === 'safe-storage') {
        if (!encrypted()) throw new Error();
        state = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')));
      } else if (envelope.kind === 'private-file') state = JSON.parse(envelope.payload);
      else throw new Error();
      if (
        !state ||
        typeof state.token !== 'string' ||
        state.token.length < 24 ||
        state.token.length > 256 ||
        !state.sessions ||
        typeof state.sessions !== 'object' ||
        Array.isArray(state.sessions) ||
        Object.keys(state.sessions).length > 32 ||
        Object.entries(state.sessions).some(
          ([id, value]) => !/^[a-f0-9]{64}$/.test(id) || value !== true,
        )
      )
        throw new Error();
      chmodSync(filePath, 0o600);
    } catch {
      throw new Error('远程配对数据读取失败；原文件已保留。');
    }
  } else {
    const initial = token ?? randomBytes(24).toString('base64url');
    if (typeof initial !== 'string' || initial.length < 24 || initial.length > 256)
      throw new Error('The pairing token must contain 24–256 characters.');
    state = { token: initial, sessions: {} };
    persist(state);
  }
  function commit(next) {
    persist(next);
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }
  return {
    get token() {
      return state.token;
    },
    accepts(value) {
      return (
        typeof value === 'string' &&
        timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(hash(state.token), 'hex'))
      );
    },
    get(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
      return state.sessions[hash(id)] === true ? { paired: true } : null;
    },
    issue(previousId) {
      const sessions = { ...state.sessions };
      if (typeof previousId === 'string') delete sessions[hash(previousId)];
      if (Object.keys(sessions).length >= 32)
        throw Object.assign(new Error('Too many paired browsers.'), { status: 429 });
      const id = randomBytes(32).toString('hex');
      sessions[hash(id)] = true;
      commit({ ...state, sessions });
      return { id };
    },
    revoke(id) {
      if (typeof id !== 'string' || !Object.hasOwn(state.sessions, hash(id))) return;
      const sessions = { ...state.sessions };
      delete sessions[hash(id)];
      commit({ ...state, sessions });
    },
    reset() {
      commit({ token: randomBytes(24).toString('base64url'), sessions: {} });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createWebAuthStore, atomicPrivateWrite };
