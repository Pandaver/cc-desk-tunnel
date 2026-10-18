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

function externalLink(target, advertisedOrigin) {
  const url = new URL(String(target));
  // Keep the existing official sign-in and project links unchanged.
  if (
    url.protocol === 'https:' &&
    /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$|^github\.com$/.test(url.hostname)
  )
    return url.href;
  const origin = webOrigin(advertisedOrigin);
  if (
    origin &&
    url.origin === origin &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    (!url.hash || /^#pair=[a-f0-9]{24}$/.test(url.hash)) &&
    url.href === `${origin}/${url.hash}`
  )
    return url.href;
  throw new Error('Unexpected link');
}

module.exports = { externalLink, webOrigin };
