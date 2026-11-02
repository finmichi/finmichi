// SPDX-License-Identifier: AGPL-3.0-only
import { importInvestments, revertInvestments } from './investments.js';
import { parseArgs } from 'node:util';
import { realpath, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connect } from '@finmichi/db';
import { canonicalJson } from '@finmichi/core';
import { readBundle, readMapping, readLimited, sha256 } from './bundle.js';
import { transform, encodePlan } from './transform.js';
import { ImportError, planSchema, shaSchema } from './schema.js';
import { applyPlan, validatedPlan } from './import.js';
import {
  reconcilePlan,
  reconcileDatabase,
  compareBaseline,
} from './reconcile.js';
export async function atomicWrite(path: string, content: string) {
  const temp = path + '.tmp.' + randomUUID();
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
export async function readPlan(path: string) {
  const raw = JSON.parse((await readLimited(path)).toString('utf8'));
  const envelope = z
    .object({ payloadSha256: shaSchema, plan: z.unknown() })
    .strict()
    .parse(raw);
  if (sha256(canonicalJson(envelope.plan)) !== envelope.payloadSha256)
    throw new ImportError('dataset_checksum_mismatch');
  return planSchema.parse(envelope.plan);
}
async function privateReportPath(path: string) {
  let dir = await realpath(dirname(resolve(path)));
  for (;;) {
    if (
      await lstat(resolve(dir, '.git')).then(
        async (s) =>
          s.isFile() ||
          (await lstat(resolve(dir, '.git', 'HEAD')).then(
            () => true,
            () => false,
          )),
        () => false,
      )
    )
      throw new ImportError('report_path_not_private');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
let reportPath: string | undefined;
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string' },
      'ledger-id': { type: 'string' },
      revert: { type: 'string' },
      out: { type: 'string' },
      mapping: { type: 'string' },
      'opening-date': { type: 'string' },
      'owner-subject': { type: 'string' },
      'ledger-name': { type: 'string' },
      apply: { type: 'boolean', default: false },
      'allow-duplicate-ledger': { type: 'boolean', default: false },
      baseline: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !['analyze', 'transform', 'import', 'reconcile', 'investments'].includes(
      command ?? '',
    ) ||
    !values.out
  )
    throw new ImportError(
      'usage: analyze|transform|import|reconcile --input PRIVATE_INPUT --out PRIVATE_JSON',
    );
  reportPath = values.out;
  if (command === 'investments') {
    reportPath = undefined;
    await privateReportPath(values.out);
    reportPath = values.out;
    if (
      !values['owner-subject'] ||
      !values['ledger-id'] ||
      !process.env.DATABASE_URL ||
      values.baseline ||
      values['ledger-name'] ||
      values['opening-date'] ||
      values['allow-duplicate-ledger'] ||
      (values.revert
        ? !!values.input || !!values.mapping
        : !values.input || !values.mapping)
    )
      throw new ImportError('invalid_command_options');
    const db = connect(process.env.DATABASE_URL);
    try {
      const opts = {
        ownerSubject: values['owner-subject'],
        ledgerId: values['ledger-id'],
        apply: values.apply,
      };
      const mappingData = values.mapping
        ? await readLimited(values.mapping, 1024 * 1024)
        : null;
      const result = values.revert
        ? await revertInvestments(db, values.revert, opts)
        : await importInvestments(
            db,
            await readBundle(values.input!),
            JSON.parse(mappingData!.toString('utf8')),
            { ...opts, mappingSha256: sha256(mappingData!) },
          );
      await atomicWrite(values.out, JSON.stringify(result, null, 2) + '\n');
      console.log(
        JSON.stringify({
          command,
          dry_run: result.dry_run,
          ...('counts' in result ? { counts: result.counts } : {}),
        }),
      );
    } finally {
      await db.end();
    }
    return;
  }
  if (values.revert || values['ledger-id'])
    throw new ImportError('invalid_command_options');
  if (
    (values.apply && command !== 'import') ||
    (values['allow-duplicate-ledger'] &&
      (!values.apply || command !== 'import'))
  )
    throw new ImportError('invalid_command_options');
  if (command === 'analyze' || command === 'transform') {
    if (
      !values.input ||
      values.baseline ||
      values['owner-subject'] ||
      values['ledger-name']
    )
      throw new ImportError('invalid_command_options');
    const bundle = await readBundle(values.input),
      { mapping, mappingSha256 } = await readMapping(values.mapping),
      plan = transform(bundle, mapping, mappingSha256, values['opening-date']);
    const { warnings, ...report } = plan.report;
    await atomicWrite(
      values.out,
      command === 'transform'
        ? encodePlan(plan)
        : JSON.stringify(
            {
              warnings,
              ...report,
              transaction_count: plan.transactions.length,
              source_sha256: plan.source_sha256,
              mapping_sha256: plan.mapping_sha256,
            },
            null,
            2,
          ) + '\n',
    );
    console.log(
      JSON.stringify({
        command,
        errors: plan.report.errors.length,
        skipped: plan.report.skipped.length,
        transactions: plan.transactions.length,
        warnings: plan.report.warnings,
      }),
    );
    if (plan.report.errors.length) process.exitCode = 1;
    return;
  }
  if (values.mapping || values['opening-date'])
    throw new ImportError('mapping_requires_retransform');
  if (command === 'import') {
    if (!values.input || values.baseline)
      throw new ImportError('invalid_command_options');
    const plan = await readPlan(values.input);
    if (!values.apply) {
      await atomicWrite(
        values.out,
        JSON.stringify(
          {
            warnings: plan.report.warnings,
            dry_run: true,
            source_sha256: plan.source_sha256,
            report: plan.report,
            reconciliation: reconcilePlan(plan),
          },
          null,
          2,
        ) + '\n',
      );
      console.log(
        JSON.stringify({
          command,
          dry_run: true,
          transactions: plan.transactions.length,
          warnings: plan.report.warnings,
        }),
      );
      if (plan.report.errors.length) process.exitCode = 1;
      return;
    }
    validatedPlan(plan);
    if (!values['owner-subject'] || !values['ledger-name'])
      throw new ImportError('owner_subject_and_ledger_name_required');
    if (!process.env.DATABASE_URL)
      throw new ImportError('database_url_required');
    const db = connect(process.env.DATABASE_URL);
    try {
      const result = await applyPlan(db, plan, {
        ownerSubject: values['owner-subject'],
        ledgerName: values['ledger-name'],
        allowDuplicateLedger: values['allow-duplicate-ledger'],
      });
      await atomicWrite(values.out, JSON.stringify(result, null, 2) + '\n');
      console.log(
        JSON.stringify({
          command,
          applied: true,
          imported_count: result.imported_count,
        }),
      );
    } finally {
      await db.end();
    }
    return;
  }
  let result;
  if (values.input) {
    if (values['owner-subject'] || values['ledger-name'])
      throw new ImportError('choose_dataset_or_database');
    result = reconcilePlan(validatedPlan(await readPlan(values.input)));
  } else {
    if (
      !process.env.DATABASE_URL ||
      !values['owner-subject'] ||
      !values['ledger-name']
    )
      throw new ImportError('database_owner_and_ledger_required');
    const db = connect(process.env.DATABASE_URL);
    try {
      result = await reconcileDatabase(
        db,
        values['owner-subject'],
        values['ledger-name'],
      );
    } finally {
      await db.end();
    }
  }
  const comparison = values.baseline
    ? compareBaseline(
        result,
        JSON.parse((await readLimited(values.baseline)).toString('utf8')),
      )
    : null;
  await atomicWrite(
    values.out,
    JSON.stringify({ reconciliation: result, comparison }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ command, matches: comparison?.matches ?? null }),
  );
  if (comparison && !comparison.matches) process.exitCode = 2;
}
main().catch(async (error) => {
  const code =
    error instanceof ImportError ? error.code : 'invalid_input_or_database';
  if (reportPath)
    await atomicWrite(
      reportPath,
      JSON.stringify(
        {
          error: code,
          ...(error instanceof ImportError ? { details: error.details } : {}),
        },
        null,
        2,
      ) + '\n',
    ).catch(() => {});
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
