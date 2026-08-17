/**
 * Shared HTTP test helpers for Legacy: Registry.
 *
 * `signInAsBootstrapOwner(baseUrl)` runs the two-step magic-link handshake
 * against a fresh Registry (bootstrap mode) and returns a cookie string
 * ready to hand to `fetch(..., { headers: { cookie } })`.
 *
 * This assumes the server is started with REINDEER_MAILER_OFF=1 so the
 * link URL is echoed back in the request-link response \u2014 that is the
 * intended local-development path and the only path a test can drive
 * without an inbox.
 */
export const TEST_OWNER_EMAIL = 'test-owner@localhost.test';

/**
 * The helper uses a fixed test-owner email so multiple test suites can
 * share a running server: the first to run mints the owner in bootstrap
 * mode; subsequent runs sign that same owner back in.
 */
export async function signInAsBootstrapOwner(baseUrl, email = TEST_OWNER_EMAIL) {
  const link = await requestMagicLink(baseUrl, email);
  return await consumeMagicLink(baseUrl, link);
}

export async function requestMagicLink(baseUrl, email) {
  const res = await fetch(`${baseUrl}/api/auth/request-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`request-link failed: ${res.status}`);
  const body = await res.json();
  if (!body.link) throw new Error('request-link did not echo link URL \u2014 is REINDEER_MAILER_OFF=1?');
  return body.link;
}

export async function consumeMagicLink(baseUrl, linkUrl) {
  // The verify handler redirects by default. Request JSON so we can grab
  // the Set-Cookie header without following a redirect that would drop it.
  const res = await fetch(linkUrl, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new Error(`verify failed: ${res.status} ${text}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('verify response carried no Set-Cookie');
  // Cookie header we send back is just the name=value pair \u2014 no
  // Path/HttpOnly/etc. Undici's Set-Cookie may be a raw string; strip
  // attributes.
  const cookie = setCookie.split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.startsWith('reindeer_session='))
    .join('; ');
  if (!cookie) throw new Error('verify did not set reindeer_session cookie');
  return cookie;
}

/**
 * Wrap fetch to auto-inject the cookie header. Returns a `fetch`-shaped
 * function.
 */
export function authedFetch(cookie) {
  return (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('cookie', cookie);
    return fetch(url, { ...init, headers });
  };
}
