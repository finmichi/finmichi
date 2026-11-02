// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
import type { Database } from '@finmichi/db';
import {
  IDLE_SECONDS,
  SESSION_SECONDS,
  newToken,
  tokenHash,
  isAllowed,
} from './index.js';
export function sessionService(
  db: Database,
  allowedSubjects: readonly string[],
) {
  return {
    async login(issuer: string, subject: string, sourceIp?: string) {
      if (!isAllowed(subject, allowedSubjects)) {
        const ip = sourceIp && isIP(sourceIp) ? sourceIp : null;
        await db`INSERT INTO audit_logs(action,outcome,source_ip,subject_hash) VALUES ('login','denied',${ip},${tokenHash(subject)})`;
        return null;
      }
      const token = newToken();
      await db.begin(async (sql) => {
        await sql`DELETE FROM sessions WHERE expires_at <= now() OR last_seen_at <= now()-${IDLE_SECONDS}*interval '1 second'`;
        const [user] =
          await sql`INSERT INTO users(oidc_issuer,oidc_subject) VALUES (${issuer},${subject}) ON CONFLICT (oidc_issuer,oidc_subject) DO UPDATE SET oidc_subject = EXCLUDED.oidc_subject RETURNING id`;
        if (!user) throw new Error('User creation failed');
        await sql`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (${tokenHash(token)},${user.id},now()+${SESSION_SECONDS}*interval '1 second')`;
        await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${user.id},'login','success')`;
      });
      return token;
    },
    async authenticate(token: string | undefined) {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const [user] =
        await db`UPDATE sessions s SET last_seen_at=now() FROM users u WHERE s.token_hash=${tokenHash(token)} AND s.user_id=u.id AND s.expires_at>now() AND s.last_seen_at>now()-${IDLE_SECONDS}*interval '1 second' AND u.oidc_subject IN ${db(allowedSubjects)} RETURNING u.id,u.oidc_subject AS subject`;
      return user
        ? { id: String(user.id), subject: String(user.subject) }
        : null;
    },
    async logout(token: string | undefined) {
      if (!token) return;
      await db.begin(async (sql) => {
        const [session] =
          await sql`DELETE FROM sessions WHERE token_hash=${tokenHash(token)} RETURNING user_id`;
        if (session)
          await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${session.user_id},'logout','success')`;
      });
    },
  };
}
