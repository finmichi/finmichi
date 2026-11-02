// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
try {
  const h = JSON.parse(await readFile('/tmp/worker-health.json', 'utf8'));
  if (!Number.isFinite(h.at) || Date.now() - h.at > 120000) process.exit(1);
} catch {
  process.exit(1);
}
