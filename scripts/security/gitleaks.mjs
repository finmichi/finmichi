// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export function addedContent(patch) {
  const lines = [],
    positions = [];
  let next = null;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('diff --git')) {
      next = null;
      continue;
    }
    if (next === null) continue;
    if (line.startsWith('+')) {
      lines.push(line.slice(1));
      positions.push(next++);
    } else if (line.startsWith(' ')) next++;
  }
  return { text: lines.join('\n'), positions };
}
export const addedLines = (patch) => addedContent(patch).text;
export function scanSecrets({
  history = false,
  base,
  head,
  reportOnly = false,
} = {}) {
  const work = mkdtempSync(join(tmpdir(), 'finmichi-secret-scan-'));
  try {
    const binary =
      process.env.GITLEAKS_BIN ??
      join(
        process.env.RUNNER_TEMP ?? '/tmp',
        'finmichi-security-tools/gitleaks',
      );
    const report = join(work, 'report.json');
    const config = join(work, 'default.toml');
    writeFileSync(config, '[extend]\nuseDefault = true\n');
    const locations = new Map();
    const flags = [
      '--no-banner',
      '--no-color',
      '--redact=100',
      '--ignore-gitleaks-allow',
      '--report-format',
      'json',
      '--report-path',
      report,
      '--config',
      config,
      '--gitleaks-ignore-path',
      join(work, 'no-ignore'),
    ];
    let args,
      files = 0;
    if (history) args = ['git', ...flags, '--log-opts=--all', '.'];
    else {
      const tree = join(work, 'added');
      mkdirSync(tree);
      if (base || head) {
        if (![base, head].every((s) => /^[a-f0-9]{40}$/.test(s ?? '')))
          throw new Error('Expected immutable scan base/head');
        const ancestor = git(['merge-base', base, head]).trim();
        const paths = git([
          'diff',
          '--no-renames',
          '--diff-filter=ACM',
          '--name-only',
          '-z',
          ancestor,
          head,
        ])
          .split('\0')
          .filter(Boolean);
        for (const path of paths) {
          const patch = git([
            'diff',
            '--no-ext-diff',
            '--text',
            '--no-renames',
            '--unified=0',
            ancestor,
            head,
            '--',
            path,
          ]);
          const { text, positions } = addedContent(patch);
          if (!text) continue;
          // Opaque filenames prevent arbitrary repository paths from escaping staging.
          const name = `${files++}.txt`;
          locations.set(name, { path, positions });
          writeFileSync(join(tree, name), text, { mode: 0o600 });
        }
      } else {
        // main/manual scan of every tracked text file; never include local ignored secrets.
        for (const path of git(['ls-files', '-z'])
          .split('\0')
          .filter(Boolean)) {
          if (!lstatSync(path).isFile()) continue; // File policy rejects links; never follow them.
          const bytes = readFileSync(path);
          if (bytes.includes(0)) continue;
          const name = `${files++}.txt`;
          locations.set(name, { path });
          writeFileSync(join(tree, name), bytes, { mode: 0o600 });
        }
      }
      args = ['dir', ...flags, tree];
    }
    const r = spawnSync(binary, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (![0, 1].includes(r.status))
      throw new Error('gitleaks execution failed');
    const raw = JSON.parse(readFileSync(report, 'utf8'));
    const findings = raw.map((x) => {
      const location = locations.get(x.File.split('/').at(-1));
      return {
        rule: x.RuleID,
        path: history ? x.File : (location?.path ?? 'added-content'),
        line: location?.positions?.[x.StartLine - 1] ?? x.StartLine,
        commit: history ? x.Commit : undefined,
      };
    });
    const result = {
      mode: history ? 'history' : base ? 'pr-added-diff' : 'tracked-tree',
      files,
      findings,
      passed: findings.length === 0,
    };
    if (process.env.SECURITY_REPORT) {
      const output = resolve(process.env.SECURITY_REPORT);
      mkdirSync(resolve(output, '..'), { recursive: true });
      writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(result));
    return findings.length && !reportOnly ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = scanSecrets({
      history: process.argv.includes('--history'),
      reportOnly: process.argv.includes('--report-only'),
      base: process.env.CI_BASE_SHA,
      head: process.env.CI_HEAD_SHA,
    });
  } catch {
    console.error('Secret scan failed to execute; no sensitive output emitted');
    process.exitCode = 2;
  }
}
