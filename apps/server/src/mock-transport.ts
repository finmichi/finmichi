// SPDX-License-Identifier: AGPL-3.0-only
import { request } from 'node:http';
import type { CustomFetch } from 'openid-client';
// Development-only transport: keep the public Host/issuer while dialing Docker DNS.
// Node fetch ignores Host; node:http preserves it. No issuer rewriting or relaxed JWT validation.
export function mockTransport(
  issuerUrl: string,
  internalUrl: string,
): CustomFetch {
  const issuer = new URL(issuerUrl);
  const internal = new URL(internalUrl);
  if (internal.protocol !== 'http:')
    throw new Error('Mock transport requires internal HTTP');
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== issuer.origin) throw new Error('Unexpected OIDC origin');
    const target = new URL(internal);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = new Headers(init.headers);
    headers.set('host', issuer.host);
    const body = init.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !(body instanceof URLSearchParams)
    )
      throw new Error('Unsupported mock request body');
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        target,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(headers.entries()),
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024)
              req.destroy(new Error('Mock response too large'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            const resultHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined)
                for (const item of Array.isArray(value) ? value : [value])
                  resultHeaders.append(key, item);
            }
            resolve(
              new Response(Buffer.concat(chunks).toString('utf8'), {
                status: response.statusCode ?? 500,
                headers: resultHeaders,
              }),
            );
          });
        },
      );
      req.setTimeout(10000, () => req.destroy(new Error('Mock OIDC timeout')));
      req.on('error', reject);
      req.end(body?.toString());
    });
  };
}
