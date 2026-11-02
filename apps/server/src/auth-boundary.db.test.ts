// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { HTTPMethods } from 'fastify';
import { fixture } from '../test/catalog-fixture.js';

const observed = vi.hoisted(() => ({
  routes: [] as {
    method: HTTPMethods;
    url: string;
    calls: () => number;
  }[],
}));

// Attach before createApp registers any route, including automatic HEAD routes.
vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  return {
    ...actual,
    default: (...args: Parameters<typeof actual.default>) => {
      const app = actual.default(...args);
      app.addHook('onRoute', (options) => {
        if (!options.url.startsWith('/api/') && options.url !== '/mcp') return;
        const handler = vi.fn(options.handler);
        options.handler = handler;
        for (const method of [options.method].flat())
          observed.routes.push({
            method,
            url: options.url,
            calls: () => handler.mock.calls.length,
          });
      });
      return app;
    },
  };
});

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('auth-boundary');
});
afterAll(async () => {
  if (f) await f.close();
});

const handlerCalls = () => observed.routes.map((route) => route.calls());
const origin = { origin: 'https://ledger.synthetic.invalid' };
const apiPaths = (path: string) => [
  path,
  path.replace('/api/', '/%61pi/'),
  path.replace('/api/', '/ap%69/'),
];

it.each(['/%61pi/ledgers', '/ap%69/ledgers/:ledger/budgets', '/%61pi/me'])(
  'rejects unauthenticated %s before its handler',
  async (path) => {
    const before = handlerCalls();
    const response = await f.app.inject(path.replace(':ledger', f.ledger));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(handlerCalls()).toEqual(before);
  },
);

it('requires a session for every registered API method and encoded equivalent', async () => {
  const protectedRoutes = [
    ...new Map(
      observed.routes
        .filter(
          (route) =>
            route.url.startsWith('/api/') && route.url !== '/api/health',
        )
        .map((route) => [`${route.method} ${route.url}`, route]),
    ).values(),
  ];
  expect(protectedRoutes.length).toBeGreaterThan(0);
  for (const url of ['/api/me', '/api/ledgers', '/api/ledgers/:ledger/budgets'])
    expect(protectedRoutes.some((route) => route.url === url)).toBe(true);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
    expect(protectedRoutes.some((route) => route.method === method)).toBe(true);
  const before = handlerCalls();
  let probes = 0;
  for (const route of protectedRoutes) {
    const path = route.url.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, f.ledger);
    for (const url of apiPaths(path)) {
      const label = `${route.method} ${route.url} via ${url}`;
      const response = await f.app.inject({
        method: route.method,
        url,
        headers: origin,
      });
      expect(response.statusCode, label).toBe(401);
      expect(response.headers['cache-control'], label).toBe('no-store');
      if (route.method === 'HEAD') expect(response.body, label).toBe('');
      else expect(response.json(), label).toEqual({ error: 'unauthorized' });
      expect(handlerCalls(), label).toEqual(before);
      probes++;
    }
  }
  console.log(
    JSON.stringify({
      api_methods: protectedRoutes.length,
      unauthorized_probes: probes,
      handlers_entered: 0,
    }),
  );
});

it('keeps health public and authenticates valid sessions on encoded routes', async () => {
  for (const url of apiPaths('/api/health')) {
    expect((await f.app.inject(url)).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
  }
  const me = observed.routes.find(
    (route) => route.method === 'GET' && route.url === '/api/me',
  )!;
  const before = me.calls();
  for (const url of apiPaths('/api/me')) {
    const response = await f.app.inject({ url, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: f.actor } });
  }
  expect(me.calls()).toBe(before + 3);
  expect(
    (await f.app.inject({ url: '/%61pi/ledgers', headers: f.headers }))
      .statusCode,
  ).toBe(200);
});

it('uses the matched MCP pattern for Origin exemption while retaining MCP authentication and Origin checks', async () => {
  const before = handlerCalls();
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    for (const url of ['/mcp', '/%6dcp', '/mc%70']) {
      const missing = await f.app.inject({ method, url });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer');
      const foreign = await f.app.inject({
        method,
        url,
        headers: { origin: 'https://evil.invalid' },
      });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toEqual({ error: 'origin_denied' });
    }
  }
  expect(handlerCalls()).toEqual(before);
});

it('preserves the current unmatched-route authentication, Origin and SPA behavior', async () => {
  expect((await f.app.inject('/api/not-a-route')).statusCode).toBe(401);
  expect(
    (await f.app.inject({ url: '/api/not-a-route', headers: f.headers }))
      .statusCode,
  ).toBe(404);
  const encoded = await f.app.inject('/%61pi/not-a-route');
  expect(encoded.statusCode).toBe(200);
  expect(encoded.headers['content-type']).toContain('text/html');
  expect((await f.app.inject('/auth/not-a-route')).statusCode).toBe(404);
  expect((await f.app.inject({ method: 'PUT', url: '/mcp' })).statusCode).toBe(
    404,
  );
  expect(
    (await f.app.inject({ method: 'PUT', url: '/%6dcp' })).statusCode,
  ).toBe(403);
});
