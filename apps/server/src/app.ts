// SPDX-License-Identifier: AGPL-3.0-only
import { reminderRoutes } from './reminder-routes.js';
import { dataResetRoutes } from './data-reset-routes.js';
import { dataResetService } from '@finmichi/core';
import { depositRoutes } from './deposit-routes.js';
import { dividendRoutes } from './dividend-routes.js';
import { securitiesRoutes } from './securities-routes.js';
import { marketRoutes } from './market-routes.js';
import { draftRoutes } from './draft-routes.js';
import { draftLimitSchema, DEFAULT_DRAFT_LIMIT } from '@finmichi/core';
import { financeRoutes } from './finance-routes.js';
import { budgetRoutes } from './budget-routes.js';
import { mcpRoutes } from './mcp-routes.js';
import { patRoutes } from './pat-routes.js';
import { auditRoutes } from './audit-routes.js';
import { backupRoutes } from './backup-routes.js';
import { life2023Routes } from './life2023-routes.js';
import { reportRoutes } from './report-routes.js';
import { transactionRoutes } from './transaction-routes.js';
import { recurringRoutes } from './recurring-routes.js';
import { catalogRoutes } from './catalog-routes.js';
import { DomainError, BackupReferenceError } from '@finmichi/core';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import * as oidc from 'openid-client';
import { mockTransport } from './mock-transport.js';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  connect,
  operationalErrorClass,
  operationalErrorCode,
  type Database,
} from '@finmichi/db';
import {
  identitySchema,
  newToken,
  tokenHash,
  sameOrigin,
  SESSION_SECONDS,
} from '@finmichi/core';
import { sessionService } from '@finmichi/core';
export interface Settings {
  databaseUrl: string;
  publicUrl: string;
  issuer: string;
  clientId: string;
  allowedSubjects: string[];
  trustProxy: number;
  version: string;
  draftMaxBaseAmount?: string;
  clientSecret?: string;
  subjectDiscovery?: boolean;
  allowFactoryReset?: boolean;
  mockInternalUrl?: string;
  tlsKey?: string;
  tlsCert?: string;
}
export function settings(): Settings {
  const required = (name: string) => {
    const value =
      process.env[name] ??
      (process.env[name + '_FILE']
        ? readFileSync(process.env[name + '_FILE']!, 'utf8').trim()
        : undefined);
    if (!value) throw new Error(`${name} required`);
    return value;
  };
  const publicUrl = required('PUBLIC_URL');
  if (new URL(publicUrl).protocol !== 'https:')
    throw new Error('PUBLIC_URL must use HTTPS for Secure cookies');
  const allowedSubjects = required('ALLOWED_SUBJECTS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowedSubjects.length)
    throw new Error('ALLOWED_SUBJECTS must not be empty');
  const trustProxy = Number(process.env.TRUST_PROXY ?? '0');
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 1)
    throw new Error('TRUST_PROXY must be 0 or 1');
  const config: Settings = {
    allowFactoryReset: process.env.FINMICHI_ALLOW_FACTORY_RESET === 'true',
    subjectDiscovery:
      process.env.NODE_ENV === 'production' &&
      process.env.OIDC_SUBJECT_DISCOVERY === 'true',
    databaseUrl: required('DATABASE_URL'),
    publicUrl,
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    allowedSubjects,
    trustProxy,
    version: process.env.APP_VERSION ?? '0.0.1',
    draftMaxBaseAmount: draftLimitSchema.parse(
      process.env.MCP_DRAFT_MAX_BASE_AMOUNT ?? DEFAULT_DRAFT_LIMIT,
    ),
  };
  for (const [key, env] of [
    ['clientSecret', 'OIDC_CLIENT_SECRET'],
    ['mockInternalUrl', 'MOCK_OIDC_INTERNAL_URL'],
    ['tlsKey', 'TLS_KEY_FILE'],
    ['tlsCert', 'TLS_CERT_FILE'],
  ] as const) {
    const value =
      process.env[env] ??
      (process.env[env + '_FILE']
        ? readFileSync(process.env[env + '_FILE']!, 'utf8').trim()
        : undefined);
    if (value) config[key] = value;
  }
  if (config.mockInternalUrl && process.env.NODE_ENV !== 'development')
    throw new Error('Mock OIDC transport is development-only');
  if (Boolean(config.tlsKey) !== Boolean(config.tlsCert))
    throw new Error('Both TLS files required');
  return config;
}
export async function createApp(config: Settings, database?: Database) {
  const draftLimit = draftLimitSchema.parse(
    config.draftMaxBaseAmount ?? DEFAULT_DRAFT_LIMIT,
  );
  const db = database ?? connect(config.databaseUrl);
  const tls =
    config.tlsKey && config.tlsCert
      ? {
          key: await readFile(config.tlsKey),
          cert: await readFile(config.tlsCert),
        }
      : undefined;
  const app = Fastify({
    ...(tls ? { https: tls } : {}),
    trustProxy: (_address, hop) => hop < config.trustProxy,
    logger: {
      level: 'info',
      serializers: {
        err: (error) => ({
          type:
            operationalErrorCode(error, 'app_failed') === 'app_failed'
              ? operationalErrorClass(error)
              : 'Error',
          message: operationalErrorCode(error, 'app_failed'),
          stack: '',
        }),
        req: (req) => ({
          method: req.method,
          path: String(req.url).split('?')[0],
          client_ip: req.ip,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers.set-cookie',
      ],
    },
  });
  const subjectDiscovery =
    process.env.NODE_ENV === 'production' && config.subjectDiscovery === true;
  if (subjectDiscovery)
    app.log.warn(
      { event: 'oidc_subject_discovery_enabled' },
      'Temporary subject discovery enabled; disable after setup',
    );
  if (!database)
    app.addHook('onClose', async () => {
      await db.end();
    });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 30,
    timeWindow: '1 minute',
  });
  const sessions = sessionService(db, config.allowedSubjects);
  const dataReset = dataResetService(db, config.allowFactoryReset === true);
  const authConfig = config.mockInternalUrl
    ? await oidc.discovery(
        new URL(config.issuer),
        config.clientId,
        undefined,
        oidc.None(),
        {
          execute: [oidc.allowInsecureRequests],
          [oidc.customFetch]: mockTransport(
            config.issuer,
            config.mockInternalUrl,
          ),
        },
      )
    : await oidc.discovery(
        new URL(config.issuer),
        config.clientId,
        config.clientSecret,
      );
  const attempts = new Map<
    string,
    {
      state: string;
      nonce: string;
      verifier: string;
      expires: number;
      expectedActor?: string;
      returnTo: string;
    }
  >();
  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
  };
  app.setErrorHandler((error, request, reply) => {
    const status =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    request.log.error(
      { event: 'request_failed', status: status },
      'Request failed',
    );
    reply.code(status).send({
      error:
        error instanceof DomainError
          ? error.code
          : error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' &&
              request.routeOptions.url?.startsWith('/api/backup-restores/')
            ? 'backup_too_large'
            : 'request_failed',
      ...(error instanceof DomainError && error.details
        ? { details: error.details }
        : {}),
      ...(error instanceof BackupReferenceError
        ? { issues: error.issues, issue_count: error.issueCount }
        : {}),
    });
  });
  app.decorateRequest('actor', null);
  app.decorateRequest('mcpPrincipal', null);
  app.addHook('onRequest', async (request, reply) => {
    // Follow the router's decoded identity; retain existing not-found behavior.
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    reply
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');
    if (
      path !== '/mcp' &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !sameOrigin(request.headers.origin, config.publicUrl)
    )
      return reply.code(403).send({ error: 'origin_denied' });
    if (path?.startsWith('/api/') && path !== '/api/health') {
      reply.header('cache-control', 'no-store');
      const user = await sessions.authenticate(request.cookies.session);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      request.actor = user;
    }
  });
  app.get('/api/health', async (_request, reply) => {
    try {
      await db`SELECT 1`;
      return { status: 'ok', database: 'connected', version: config.version };
    } catch {
      return reply.code(503).send({
        status: 'error',
        database: 'unavailable',
        version: config.version,
      });
    }
  });
  app.get('/api/me', async (request) => ({
    user: request.actor,
    safety: await dataReset.status(request.actor!.id, request.cookies.session),
  }));
  app.get(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const query = _request.query as Record<string, unknown>;
      const reauth = query.reauth === '1';
      if (query.reauth !== undefined && !reauth)
        return reply.code(400).send({ error: 'invalid_input' });
      if (
        query.return_to !== undefined &&
        (!reauth ||
          typeof query.return_to !== 'string' ||
          !['/admin/ledgers', '/admin/system'].includes(query.return_to))
      )
        return reply.code(400).send({ error: 'invalid_input' });
      const user = reauth
        ? await sessions.authenticate(_request.cookies.session)
        : null;
      if (reauth && !user)
        return reply.code(401).send({ error: 'unauthorized' });
      for (const [key, attempt] of attempts)
        if (attempt.expires < Date.now()) attempts.delete(key);
      if (attempts.size >= 1000)
        return reply.code(503).send({ error: 'try_again' });
      const binding = newToken();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      attempts.set(tokenHash(binding), {
        state,
        nonce,
        verifier,
        expires: Date.now() + 600_000,
        ...(user ? { expectedActor: user.id } : {}),
        returnTo:
          reauth && typeof query.return_to === 'string' ? query.return_to : '/',
      });
      reply
        .header('cache-control', 'no-store')
        .setCookie('oidc_flow', binding, { ...cookieOptions, maxAge: 600 });
      return reply.redirect(
        oidc.buildAuthorizationUrl(authConfig, {
          redirect_uri: new URL('/auth/callback', config.publicUrl).href,
          scope: 'openid',
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: 'S256',
          ...(reauth ? { prompt: 'login' } : {}),
        }).href,
      );
    },
  );
  app.get('/auth/callback', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .clearCookie('oidc_flow', cookieOptions);
    const key = tokenHash(request.cookies.oidc_flow ?? '');
    const attempt = attempts.get(key);
    attempts.delete(key);
    if (!attempt || attempt.expires < Date.now()) {
      await db`INSERT INTO audit_logs(action,outcome) VALUES ('login','denied')`;
      return reply.code(400).send({ error: 'invalid_auth_flow' });
    }
    try {
      const current = new URL(request.url, config.publicUrl);
      const tokens = await oidc.authorizationCodeGrant(authConfig, current, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      const identity = identitySchema.parse(tokens.claims());
      const token = await sessions.login(
        identity.iss,
        identity.sub,
        request.ip,
        attempt.expectedActor
          ? { expectedActor: attempt.expectedActor }
          : undefined,
      );
      if (!token) {
        if (!subjectDiscovery)
          return reply.code(403).send({ error: 'subject_denied' });
        request.log.warn(
          { event: 'oidc_subject_discovery_shown' },
          'Temporary subject discovery shown; disable after setup',
        );
        const escape = (value: string) =>
          value.replace(
            /[&<>"']/g,
            (char) =>
              ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
              })[char]!,
          );
        return reply
          .code(403)
          .header(
            'content-security-policy',
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          )
          .type('text/html; charset=utf-8')
          .send(
            `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登入身分確認</title><h1>登入身分確認</h1><p>此身分已通過 OIDC 驗證，但尚未獲准登入；未建立 session。</p><dl><dt>iss</dt><dd>${escape(identity.iss)}</dd><dt>sub</dt><dd>${escape(identity.sub)}</dd></dl><p>請由管理者確認這是預期的帳號，再把 sub 加入 ALLOWED_SUBJECTS。取得後立即將 OIDC_SUBJECT_DISCOVERY=false 並重建 app；不要公開此頁。</p></html>`,
          );
      }
      await sessions.logout(request.cookies.session);
      reply.setCookie('session', token, {
        ...cookieOptions,
        maxAge: SESSION_SECONDS,
      });
      return reply.redirect(attempt.returnTo);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === 'reauth_identity_mismatch'
      )
        return reply.code(403).send({ error: error.code });
      await db`INSERT INTO audit_logs(action,outcome) VALUES ('login','error')`;
      request.log.warn({ event: 'oidc_failed' }, 'OIDC callback rejected');
      return reply.code(400).send({ error: 'authentication_failed' });
    }
  });
  app.post('/auth/logout', async (request, reply) => {
    await sessions.logout(request.cookies.session);
    reply
      .clearCookie('session', cookieOptions)
      .header('cache-control', 'no-store');
    return { success: true };
  });
  mcpRoutes(app, db, config.publicUrl, draftLimit);
  draftRoutes(app, db, draftLimit);
  marketRoutes(app, db);
  securitiesRoutes(app, db);
  dividendRoutes(app, db);
  depositRoutes(app, db);
  patRoutes(app, db);
  auditRoutes(app, db);
  backupRoutes(app, db, config.version);
  dataResetRoutes(app, db, config.allowFactoryReset === true, config.version);
  reportRoutes(app, db);
  life2023Routes(app, db);
  catalogRoutes(app, db);
  recurringRoutes(app, db);
  budgetRoutes(app, db);
  financeRoutes(app, db);
  reminderRoutes(app, db);
  transactionRoutes(app, db);
  await app.register(staticFiles, {
    root: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    wildcard: false,
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/auth/')
    )
      return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
