// SPDX-License-Identifier: AGPL-3.0-only
// Loopback synthetic OIDC provider: real PKCE, nonce and RS256 verification.
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';
import { once } from 'node:events';
import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
export async function syntheticReauthProvider(issuer, clientId = 'synthetic') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'synthetic-reauth',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map(),
    prompts = [];
  let subject = 'owner';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `http://127.0.0.1:${server.address().port}/authorize`,
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      prompts.push(url.searchParams.get('prompt'));
      const code = randomUUID();
      codes.set(code, {
        subject,
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
      });
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('code', code);
      res.writeHead(302, { location: callback.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const q = new URLSearchParams(body),
        proof = codes.get(q.get('code'));
      codes.delete(q.get('code'));
      if (
        !proof ||
        createHash('sha256')
          .update(q.get('code_verifier') ?? '')
          .digest('base64url') !== proof.challenge
      )
        return json(400, { error: 'invalid_grant' });
      const at = Math.floor(Date.now() / 1000),
        header = Buffer.from(
          JSON.stringify({ alg: 'RS256', kid: jwk.kid }),
        ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          sub: proof.subject,
          aud: clientId,
          iat: at,
          exp: at + 300,
          nonce: proof.nonce,
        }),
      ).toString('base64url');
      const input = header + '.' + payload,
        idToken =
          input +
          '.' +
          sign('RSA-SHA256', Buffer.from(input), privateKey).toString(
            'base64url',
          );
      return json(200, {
        access_token: randomUUID(),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
    }
    json(404, { error: 'not_found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    prompts,
    setSubject(value) {
      subject = value;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
