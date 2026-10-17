// Relay pages keep the same relative assets and API as the local workbench. The service
// removes only this fixed prefix; it does not rewrite HTML, scripts or business messages.
export function browserBasePath(pathname = globalThis.location?.pathname ?? '/') {
  const [root, prefix, route] = pathname.split('/');
  return root === '' &&
    prefix === 'remote' &&
    route &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.exec(route)?.[0] === route
    ? `/remote/${route}/`
    : '/';
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
