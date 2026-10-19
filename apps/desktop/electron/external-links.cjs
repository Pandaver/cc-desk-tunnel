// A browser entry comes from the authenticated service, never from the page asking to open it.
function webOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === value &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      ? value
      : null;
  } catch {
    return null;
  }
}

function webEntry(state, legacy = true) {
  const origin = webOrigin(state?.origin);
  if (!origin) return null;
  // Old services advertised only an origin. A partial or invalid newer entry must not fall back to it.
  if (!Object.hasOwn(state, 'url') && !Object.hasOwn(state, 'path'))
    return legacy ? `${origin}/` : null;
  const path = state.path;
  if (
    typeof path !== 'string' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/.test(path) ||
    ['ws', 'health', 'client', 'assets'].includes(path)
  )
    return null;
  const entry = `${origin}/${path ? `${path}/` : ''}`;
  return state.url === entry ? entry : null;
}

function externalLink(target, advertisedUrl) {
  const url = new URL(String(target));
  // Keep the existing official sign-in and project links unchanged.
  if (
    url.protocol === 'https:' &&
    /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$|^github\.com$/.test(url.hostname)
  )
    return url.href;
  let entry;
  try {
    const advertised = new URL(advertisedUrl);
    entry = webEntry({
      origin: advertised.origin,
      path: advertised.pathname.slice(1, -1),
      url: advertisedUrl,
    });
  } catch {
    entry = null;
  }
  if (
    entry &&
    !url.username &&
    !url.password &&
    !url.search &&
    (!url.hash || /^#pair=[a-f0-9]{24}$/.test(url.hash)) &&
    target === url.href &&
    url.href === `${entry}${url.hash}`
  )
    return url.href;
  throw new Error('Unexpected link');
}

module.exports = { externalLink, webEntry, webOrigin };
