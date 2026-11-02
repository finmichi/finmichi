// SPDX-License-Identifier: AGPL-3.0-only
import { URLSearchParams } from 'node:url';
// Runs inside the synthetic HTTPS proxy container; trusts only generated test CA.
import assert from 'node:assert/strict';
const base = 'https://proxy:8443',
  mode = process.argv[2];
const jar = new Map();
async function req(url, options = {}) {
  const origin = new URL(url).origin,
    cookies = jar.get(origin) ?? new Map();
  const res = await fetch(url, {
    ...options,
    redirect: 'manual',
    headers: {
      ...options.headers,
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      'x-forwarded-for': '192.0.2.123',
    },
  });
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';'),
      i = pair.indexOf('=');
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  jar.set(origin, cookies);
  return { status: res.status, headers: res.headers, body: await res.text() };
}
async function login(subject) {
  jar.clear();
  let r = await req(base + '/auth/login');
  assert.equal(r.status, 302);
  const url = new URL(r.headers.get('location'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  r = await req(url);
  assert.equal(r.status, 200);
  const action = r.body.match(/<form[^>]*action=["']([^"']*)/);
  const target = new URL(action?.[1] || url, url);
  r = await req(target, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: subject, claims: '{}' }),
  });
  assert.equal(r.status, 302);
  const callback = r.headers.get('location');
  r = await req(callback);
  return { ...r, callback };
}
assert.equal((await req(base + '/api/health')).status, 200);
assert.equal((await req(base + '/api/me')).status, 401);
assert.equal(
  (
    await req(base + '/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://cross-site.invalid' },
    })
  ).status,
  403,
);
const denied = 'synthetic-discovery-<tag>&subject';
let r = await login(denied);
assert.equal(r.status, 403);
assert.equal(r.headers.get('cache-control'), 'no-store');
assert.ok(!r.headers.getSetCookie().some((x) => x.startsWith('session=')));
assert.equal((await req(base + '/api/me')).status, 401);
if (mode === 'on') {
  assert.ok(r.body.includes('synthetic-discovery-&lt;tag&gt;&amp;subject'));
  assert.ok(r.body.includes('https://mock:8080/default'));
  assert.ok(!r.body.includes('<tag>'));
  assert.ok(
    r.headers.get('content-security-policy').includes("default-src 'none'"),
  );
} else {
  assert.deepEqual(JSON.parse(r.body), { error: 'subject_denied' });
}
assert.equal((await req(r.callback)).status, 400);
r = await login('synthetic-allowed');
assert.equal(r.status, 302);
assert.equal((await req(base + '/api/me')).status, 200);
assert.match(
  r.headers.getSetCookie().find((x) => x.startsWith('session=')),
  /HttpOnly.*Secure.*SameSite=Lax/,
);
const old = new Map(jar.get(base));
assert.equal(
  (
    await req(base + '/auth/logout', {
      method: 'POST',
      headers: { origin: base },
    })
  ).status,
  200,
);
jar.set(base, old);
assert.equal((await req(base + '/api/me')).status, 401);
console.log(
  JSON.stringify({
    mode,
    health: 200,
    unauthenticated: 401,
    cross_site: 403,
    denied: 403,
    no_session: true,
    no_store: true,
    escaped: true,
    allowed: 302,
    authenticated: 200,
    logout: 200,
    session_replay: 401,
    callback_replay: 400,
  }),
);
