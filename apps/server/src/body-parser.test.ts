// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it.each(['identity', 'gzip', 'deflate', 'gzip-trailing', 'deflate-trailing'])(
  'patched SDK parser preserves %s and survives decoder completion',
  (mode) => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../test/body-parser-regression.mjs', import.meta.url),
        ),
        mode,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(mode + ' survived');
  },
);
