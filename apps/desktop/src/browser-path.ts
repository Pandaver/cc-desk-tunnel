// Relay pages keep the same relative assets and API as the local workbench. The service
// removes only this fixed prefix; it does not rewrite HTML, scripts or business messages.
export function browserBasePath(pathname = globalThis.location?.pathname ?? '/') {
  return pathname.match(/^\/remote\/[a-f0-9]{32}(?:\/|$)/)?.[0].replace(/\/?$/, '/') ?? '/';
}

export function browserApi(path: string) {
  return `${browserBasePath()}api/${path}`;
}

// Paths on one origin share browser storage. Namespace workbench state to prevent accidental
// cross-device recovery; this is not a security boundary between mutually untrusted desktops.
export function browserStorageKey(key: string) {
  const base = browserBasePath();
  return base === '/' ? key : `${base}:${key}`;
}
