// SPDX-License-Identifier: AGPL-3.0-only
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export function parsePatterns(value) {
  const lines = (value ?? '').split(/\r?\n/).filter((s) => s.trim());
  if (!lines.length || lines.length > 100 || lines.some((s) => s.length > 1024))
    throw new Error('ENV_IDENTIFIER_PATTERNS missing or invalid');
  try {
    return lines.map((s) => new RegExp(s, 'i'));
  } catch {
    throw new Error('ENV_IDENTIFIER_PATTERNS invalid regex');
  }
}
export function luhn(value) {
  const digits = [...value.replace(/[ -]/g, '')].map(Number);
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    digits.every(Number.isInteger) &&
    digits.reduceRight((sum, n, i) => {
      const x = (digits.length - 1 - i) % 2 ? n * 2 : n;
      return sum + (x > 9 ? x - 9 : x);
    }, 0) %
      10 ===
      0
  );
}
export function personalRules(line) {
  const rules = [];
  if (/(?<![A-Za-z0-9])[A-Z][1289][0-9]{8}(?![A-Za-z0-9])/.test(line))
    rules.push('identity_number');
  if (/(?<![A-Za-z0-9])[A-Z]{2}[0-9]{8}(?![A-Za-z0-9])/.test(line))
    rules.push('invoice_number');
  if (/(?<![A-Za-z0-9/])\/[A-Z0-9+.-]{7}(?![A-Za-z0-9+._-])/.test(line))
    rules.push('carrier_number');
  const emails = line.matchAll(
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
  );
  if (
    [...emails].some(
      ([s]) => s.split('@').at(-1).toLowerCase() !== 'example.com',
    )
  )
    rules.push('email');
  const cards = line.matchAll(
    /(?<![A-Za-z0-9.])[0-9](?:[ -]?[0-9]){12,18}(?![A-Za-z0-9.])/g,
  );
  if ([...cards].some(([s]) => luhn(s))) rules.push('payment_card');
  return rules;
}
export function lineAllowed(path, line, rule, entries) {
  return entries.some(
    (x) =>
      x.path === path &&
      x.sha256 === sha256(line) &&
      x.rules.includes(rule) &&
      x.reason?.trim(),
  );
}
export function scanText(path, text, { patterns = [], exceptions = [], mode }) {
  return text.split(/\r?\n/).flatMap((line, i) => {
    const rules =
      mode === 'environment'
        ? patterns.some((p) => p.test(line))
          ? ['environment_identifier']
          : []
        : personalRules(line);
    return rules
      .filter((rule) => !lineAllowed(path, line, rule, exceptions))
      .map((rule) => ({ path, line: i + 1, rule }));
  });
}
const textExtensions = new Set([
  '.html',
  '.css',
  '.go',
  '.md',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.json',
  '.yaml',
  '.yml',
  '.sql',
  '.sh',
  '.py',
  '.csv',
  '.txt',
  '.svg',
  '.webmanifest',
  '.toml',
  '.example',
]);
const textNames = new Set([
  'Dockerfile',
  'Dockerfile.mock-oidc',
  'postgres.Dockerfile',
  '.dockerignore',
  '.gitattributes',
  '.gitignore',
  '.prettierignore',
  '.trivyignore',
  'pre-push',
]);
// Only these root documents may use a hash-bound document registration.
const rootDocumentPaths = new Set(['LICENSE', 'NOTICE', 'AUTHORS']);
export function inspectFile(path, bytes, registry) {
  if (bytes.length > 1024 * 1024) return 'file_too_large';
  if (
    /\.(?:mdb|accdb|xlsx?|dump|bak|p12|pfx|jks|key|pem|zip|gz|tar)$/i.test(
      path,
    ) ||
    /(?:^|\/)\.env$/.test(path)
  )
    return 'file_type_forbidden';
  const ext = extname(path),
    name = path.split('/').at(-1);
  const entry = registry.find((x) => x.path === path);
  if (
    entry &&
    (!entry.reason?.trim() ||
      !entry.generation?.trim() ||
      entry.sha256 !== sha256(bytes))
  )
    return 'registration_mismatch';
  if (ext === '.png' || ext === '.ttf')
    return entry?.kind === 'asset' ? null : 'unregistered_binary';
  if (
    !textExtensions.has(ext) &&
    !textNames.has(name) &&
    !(rootDocumentPaths.has(path) && entry?.kind === 'document')
  )
    return 'file_type_forbidden';
  if (bytes.includes(0)) return 'binary_content';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return entry?.kind === 'fixture' ? null : 'unregistered_encoding';
  }
  return null;
}
export function scanRepository(mode, patterns = []) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const registry = JSON.parse(
    readFileSync('scripts/security/fixture-registry.json', 'utf8'),
  );
  const exceptions = JSON.parse(
    readFileSync(
      `scripts/security/${mode === 'environment' ? 'environment-allowlist' : 'data-allowlist'}.json`,
      'utf8',
    ),
  );
  const findings = [];
  for (const entry of [...registry, ...exceptions]) {
    if (!files.includes(entry.path) || !entry.reason?.trim())
      throw new Error('Invalid or stale scan registration');
  }
  for (const path of files) {
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isFile()) {
      findings.push({ path, rule: 'non_regular_file' });
      continue;
    }
    const bytes = readFileSync(path);
    const violation = inspectFile(path, bytes, registry);
    if (violation) {
      findings.push({ path, rule: violation });
      continue;
    }
    const registered = registry.find((x) => x.path === path);
    if (
      registered?.kind === 'asset' ||
      (mode === 'data' && registered?.kind === 'fixture')
    )
      continue;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('big5', { fatal: true }).decode(bytes);
    }
    findings.push(...scanText(path, text, { patterns, exceptions, mode }));
  }
  return { mode, files: files.length, findings };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const mode = process.argv[2];
    if (!['data', 'environment'].includes(mode))
      throw new Error('Expected data or environment scan');
    const report = scanRepository(
      mode,
      mode === 'environment'
        ? parsePatterns(process.env.ENV_IDENTIFIER_PATTERNS)
        : [],
    );
    console.log(JSON.stringify(report)); // Locations only: never emit matched text or patterns.
    if (report.findings.length) process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
