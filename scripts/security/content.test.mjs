// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sha256,
  parsePatterns,
  luhn,
  personalRules,
  scanText,
  inspectFile,
  scanRepository,
} from './content.mjs';
import { addedContent } from './gitleaks.mjs';

test('private patterns are required, validated and never echoed', () => {
  assert.throws(() => parsePatterns(''), /missing or invalid/);
  assert.throws(() => parsePatterns('['), /invalid regex/);
  const pattern = 'private-host\\.example\\.invalid';
  const findings = scanText('README.md', 'visit private-host.example.invalid', {
    mode: 'environment',
    patterns: parsePatterns(pattern),
  });
  assert.equal(findings.length, 1);
  assert.equal(JSON.stringify(findings).includes('private-host'), false);
  assert.deepEqual(
    scanText('README.md', 'sso.example.com', {
      mode: 'environment',
      patterns: parsePatterns(pattern),
    }),
    [],
  );
});
test('exceptions bind path, full line hash and rule; an added value remains blocked', () => {
  const line = 'fixture@example.invalid';
  const entries = [
    {
      path: 'a.ts',
      sha256: sha256(line),
      rules: ['email'],
      reason: 'generated negative fixture',
    },
  ];
  assert.equal(
    scanText('a.ts', line, { mode: 'data', exceptions: entries }).length,
    0,
  );
  assert.equal(
    scanText('b.ts', line, { mode: 'data', exceptions: entries }).length,
    1,
  );
  assert.equal(
    scanText('a.ts', line + ' other@example.invalid', {
      mode: 'data',
      exceptions: entries,
    }).length,
    1,
  );
});
test('identity, invoice, carrier, non-example email and Luhn card are rejected', () => {
  for (const [rule, value] of [
    ['identity_number', 'A' + '123456789'],
    ['invoice_number', 'AB' + '12345678'],
    ['carrier_number', '/' + 'AB12C34'],
    ['email', 'a@' + 'mail.invalid'],
    ['payment_card', '4111 ' + '1111 1111 1111'],
  ])
    assert.ok(personalRules(value).includes(rule), rule);
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  for (const text of [
    'a@example.com',
    'pnpm@10.18.3',
    '/PRIVATE_NOTE',
    'https://example.com/reports',
    '0.1234567890123456',
  ])
    assert.deepEqual(personalRules(text), []);
});
test('registered fixtures and assets require exact bytes; data file types and oversized files fail', () => {
  const bytes = Buffer.from('synthetic');
  const entry = {
    path: 'fixture.csv',
    kind: 'fixture',
    sha256: sha256(bytes),
    reason: 'synthetic',
    generation: 'generated locally',
  };
  assert.equal(inspectFile('fixture.csv', bytes, [entry]), null);
  assert.equal(
    inspectFile('fixture.csv', Buffer.from('changed'), [entry]),
    'registration_mismatch',
  );
  assert.equal(inspectFile('data.mdb', bytes, []), 'file_type_forbidden');
  assert.equal(inspectFile('.env', bytes, []), 'file_type_forbidden');
  assert.equal(inspectFile('data.png', bytes, []), 'unregistered_binary');
  assert.equal(
    inspectFile('file.txt', Buffer.alloc(1024 * 1024 + 1), []),
    'file_too_large',
  );
  assert.equal(inspectFile('file.txt', Buffer.from([0]), []), 'binary_content');
  assert.equal(inspectFile('data.dat', bytes, []), 'file_type_forbidden');
});
test('PR secret scan uses only net added lines, including lines starting with +++', () => {
  const result = addedContent(
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,2 @@\n-old\n+new\n++++content\n',
  );
  assert.deepEqual(result, { text: 'new\n+++content', positions: [2, 3] });
  assert.deepEqual(
    addedContent(
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n-deleted\n',
    ),
    { text: '', positions: [] },
  );
});

test('only registered exact root legal documents are accepted; hashes and encoding remain enforced', () => {
  const bytes = Buffer.from('legal document');
  const registration = (path, content = bytes) => ({
    path,
    kind: 'document',
    sha256: sha256(content),
    reason: 'approved root legal document',
    generation: 'copied from approved legal text',
  });
  for (const path of ['LICENSE', 'NOTICE', 'AUTHORS']) {
    const entry = registration(path);
    assert.equal(inspectFile(path, bytes, [entry]), null);
    assert.equal(inspectFile(path, bytes, []), 'file_type_forbidden');
    assert.equal(
      inspectFile(path, Buffer.from('modified'), [entry]),
      'registration_mismatch',
    );
    for (const [content, expected] of [
      [Buffer.from([0]), 'binary_content'],
      [Buffer.from([255]), 'unregistered_encoding'],
    ])
      assert.equal(
        inspectFile(path, content, [registration(path, content)]),
        expected,
      );
  }
  for (const path of ['docs/LICENSE', 'LICENSE2', 'license', 'OTHER'])
    assert.equal(
      inspectFile(path, bytes, [registration(path)]),
      'file_type_forbidden',
    );
});

test('registered legal documents still receive repository data and environment scans', () => {
  const before = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'finmichi-legal-scan-'));
  try {
    process.chdir(root);
    execFileSync('git', ['init', '-q']);
    mkdirSync('scripts/security', { recursive: true });
    const content = 'not-public' + '@' + 'mail.invalid\nA' + '123456789\n';
    const entries = ['LICENSE', 'NOTICE', 'AUTHORS'].map((path) => {
      writeFileSync(path, content);
      return {
        path,
        kind: 'document',
        sha256: sha256(content),
        reason: 'synthetic negative contract',
        generation: 'generated in this test',
      };
    });
    writeFileSync(
      'scripts/security/fixture-registry.json',
      JSON.stringify(entries),
    );
    for (const name of ['data', 'environment'])
      writeFileSync(`scripts/security/${name}-allowlist.json`, '[]');
    execFileSync('git', ['add', 'LICENSE', 'NOTICE', 'AUTHORS']);
    const data = scanRepository('data');
    const environment = scanRepository('environment', [/not-public/]);
    for (const { path } of entries) {
      assert.ok(
        data.findings.some((x) => x.path === path && x.rule === 'email'),
      );
      assert.ok(
        data.findings.some(
          (x) => x.path === path && x.rule === 'identity_number',
        ),
      );
      assert.ok(environment.findings.some((x) => x.path === path));
    }
  } finally {
    process.chdir(before);
    rmSync(root, { recursive: true, force: true });
  }
});
