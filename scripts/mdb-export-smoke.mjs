// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  chmod,
  utimes,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'life-mdb-stubs-'));
const image = process.env.MDB_TEST_IMAGE ?? 'life-mdb-export:test';
const sudo = process.env.MDB_TEST_SUDO === '1';
const source = join(root, 'synthetic-marker.txt');
const bin = join(root, 'bin');
const hash = (s) => createHash('sha256').update(s).digest('hex');
function docker(args) {
  return spawnSync(
    sudo ? 'sudo' : 'docker',
    sudo ? ['-n', 'docker', ...args] : args,
    { encoding: 'utf8' },
  );
}
await mkdir(bin);
await writeFile(
  source,
  'GENERATED NON-MDB MARKER; only stub commands read this file\n',
);
await utimes(
  source,
  new Date('2026-01-10T20:00:00Z'),
  new Date('2026-01-10T20:00:00Z'),
);
const sha = hash(await readFile(source));
const stubs = {
  'mdb-tables': '#!/bin/sh\nprintf "ITEM_DATA\\nMYMONEY_DATA\\n"\n',
  'mdb-count': '#!/bin/sh\nprintf "1\\n"\n',
  'mdb-schema': '#!/bin/sh\nprintf "%s\\n" "-- synthetic schema"\n',
  'mdb-export':
    '#!/bin/sh\nfor arg do last=$arg; done\n[ "$last" != "${FAIL_TABLE:-}" ] || exit 42\nprintf \'"DATA_NOTE","IN_MOUNT"\\n"quoted, ""memo""\\nnext line",100\\n\'\n',
};
try {
  for (const [name, content] of Object.entries(stubs)) {
    await writeFile(join(bin, name), content);
    await chmod(join(bin, name), 0o755);
  }
  const version = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/usr/bin/mdb-export',
    image,
    '--version',
  ]);
  assert.equal(version.status, 0, version.stderr);
  console.log(
    'real mdbtools binary:',
    version.stdout.trim() || version.stderr.trim(),
  );
  async function attempt(name, mode, readOnly, fail = '') {
    const output = join(root, name);
    await mkdir(output);
    const result = docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-e',
      'PATH=/test-bin:/usr/bin:/bin',
      '-e',
      `FAIL_TABLE=${fail}`,
      '-v',
      `${bin}:/test-bin:ro,Z`,
      '-v',
      `${source}:/data/source.mdb:${readOnly ? 'ro,Z' : 'Z'}`,
      '-v',
      `${output}:/output:Z`,
      image,
      mode,
    ]);
    return { output, result };
  }
  const good = await attempt('good', 'inventory', true);
  assert.equal(good.result.status, 0, good.result.stderr);
  const manifest = await readFile(
    join(good.output, sha, 'manifest.txt'),
    'utf8',
  );
  assert.ok(manifest.startsWith(`SOURCE_SHA256|${sha}\nSOURCE_DATE|`));
  assert.ok(manifest.includes('SOURCE_DATE|2026-01-11\n'));
  const csv = await readFile(join(good.output, sha, 'item_data.csv'));
  assert.ok(manifest.includes(`ITEM_DATA|1|${hash(csv)}\n`));
  assert.ok(manifest.includes(`MYMONEY_DATA|1|${hash(csv)}\n`));
  assert.deepEqual((await readdir(good.output)).sort(), [sha]);
  assert.ok(
    (await readFile(join(good.output, sha, 'schema.sql'), 'utf8')).includes(
      'synthetic',
    ),
  );
  const failed = await attempt('failed', 'export', true, 'MYMONEY_DATA');
  assert.notEqual(failed.result.status, 0);
  assert.deepEqual(await readdir(failed.output), []);
  const rw = await attempt('rw', 'export', false);
  assert.notEqual(rw.result.status, 0);
  assert.ok(rw.result.stderr.includes('source_mount_must_be_read_only'));
  assert.deepEqual(await readdir(rw.output), []);
  assert.equal(hash(await readFile(source)), sha);
  console.log(
    'PASS: stubbed export/inventory, RFC multiline CSV hash/count, atomic failure cleanup, RW mount rejection, source unchanged',
  );
  console.log(
    'No real or generated MDB database was opened; successful exports use command stubs and a generated text marker.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
