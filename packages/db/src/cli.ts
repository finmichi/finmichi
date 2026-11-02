// SPDX-License-Identifier: AGPL-3.0-only
import { connect, migrate } from './index.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const db = connect(process.env.DATABASE_URL);
try {
  await migrate(db);
} finally {
  await db.end();
}
