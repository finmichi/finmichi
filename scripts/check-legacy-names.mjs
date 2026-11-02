// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const pattern = 'life-ledger|life_ledger|lifeledger';
const configPath = 'scripts/legacy-name-allowlist.json';
const allowlist = JSON.parse(readFileSync(configPath, 'utf8'));
function unexpected(matches, entries) {
  const approved = new Set(entries.map(({ path, text }) => path + '\0' + text));
  return matches.filter(({ path, text }) => !approved.has(path + '\0' + text));
}
// Exact lines, never a whole-file exemption: an old package/import in a
// compatibility module must still fail the gate.
assert.equal(
  unexpected(
    [{ path: 'compat.ts', text: 'old import' }],
    [{ path: 'compat.ts', text: 'legacy format' }],
  ).length,
  1,
);
assert.equal(
  unexpected(
    [{ path: 'compat.ts', text: 'legacy format' }],
    [{ path: 'compat.ts', text: 'legacy format' }],
  ).length,
  0,
);
let output;
try {
  output = execFileSync(
    'git',
    ['grep', '-n', '-i', '-E', pattern, '--', '.', `:(exclude)${configPath}`],
    { encoding: 'utf8' },
  );
} catch (error) {
  if (error.status !== 1) throw error;
  output = '';
}
const matches = output
  .trimEnd()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    assert.ok(m, 'Unexpected grep output');
    return { path: m[1], line: Number(m[2]), text: m[3] };
  });
for (const entry of allowlist) {
  assert.ok(entry.reason?.trim(), 'Every exception needs a reason');
  assert.ok(
    matches.some(
      ({ path, text }) => path === entry.path && text === entry.text,
    ),
    `Stale exception: ${entry.path}`,
  );
}
const failures = unexpected(matches, allowlist);
if (failures.length) {
  for (const x of failures) console.error(`${x.path}:${x.line}:${x.text}`);
  throw new Error(`${failures.length} unexpected legacy names`);
}
console.log(
  `Legacy name gate PASS: ${matches.length} documented exact-line compatibility/history exceptions, 0 unexpected`,
);
