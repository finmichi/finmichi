// SPDX-License-Identifier: AGPL-3.0-only
// Only run against a new isolated synthetic compose project (CI or explicit test opt-in).
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
if (!process.env.CI && process.env.FINMICHI_SYNTHETIC_CONTAINER_TEST !== '1')
  throw new Error('Synthetic container test opt-in required');
const docker = process.env.DOCKER_BIN ?? 'docker',
  file = process.env.TEST_COMPOSE_FILE ?? 'deploy/compose.dev.yaml',
  project = process.env.TEST_COMPOSE_PROJECT ?? 'finmichi-dev';
const args = ['compose', '-p', project, '-f', file];
const run = (tail) =>
  execFileSync(docker, tail, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const id = run([...args, 'ps', '-q', 'worker']).trim();
assert.ok(id);
const [info] = JSON.parse(run(['inspect', id]));
assert.equal(info.Config.Labels['com.docker.compose.project'], project);
assert.equal(info.Config.User, '65532:65532');
assert.equal(info.HostConfig.ReadonlyRootfs, true);
assert.ok(info.HostConfig.CapDrop.includes('ALL'));
assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
assert.equal(info.HostConfig.PidsLimit, 256);
assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024);
assert.equal(info.State.Health.Status, 'healthy');
const code = `
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {connect} from '@finmichi/db';
import {ledgerService,itemService,recurringService,runRecurringWorker} from '@finmichi/core';
assert.equal(process.env.NODE_ENV,'development');
for(const path of ['/bin/sh','/usr/bin/npm','/usr/local/bin/npm','/nodejs/bin/npm']){await assert.rejects(access(path));}
const db=connect((await readFile('/run/secrets/database-url','utf8')).trim());let actor,ledger,result;
try{
const [count]=await db\`SELECT count(*)::int n FROM ledgers\`;assert.equal(count.n,0,'Only a fresh empty synthetic compose DB may be tested');
const [user]=await db\`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://worker.synthetic.invalid',\${'synthetic-worker-'+Date.now()}) RETURNING id\`;actor=user.id;
ledger=await ledgerService(db).create(actor,{name:'Synthetic worker container'});
const a=await itemService(db).create(actor,ledger.id,{name:'Synthetic cash',kind:'asset',currency:'TWD'}),e=await itemService(db).create(actor,ledger.id,{name:'Synthetic expense',kind:'expense',currency:'TWD'});
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
const r=await recurringService(db).save(actor,ledger.id,{name:'Synthetic container recurrence',frequency:'monthly',day_of_month:Number(today.slice(-2)),start_on:today,end_on:today,auto_post:true,template:{entries:[{item_id:a.id,amount:'-1.00'},{item_id:e.id,amount:'1.00'}]}});
await runRecurringWorker(db,new Date(today+'T06:00:00+08:00'));await runRecurringWorker(db,new Date(today+'T06:01:00+08:00'));
const posted=await recurringService(db).occurrences(actor,ledger.id,{status:'posted'});assert.equal(posted.length,1);assert.equal(posted[0].source_rule_id,r.id);
const [tx]=await db\`SELECT source_system,source_id FROM transactions WHERE id=\${posted[0].transaction_id}\`;assert.equal(tx.source_system,'recurring');assert.equal(tx.source_id,r.id+':'+today);
const [sum]=await db\`SELECT sum(base_amount)::text s FROM transaction_entries WHERE transaction_id=\${posted[0].transaction_id}\`;assert.match(sum.s,/^0(?:[.]0+)?$/);
const state=await recurringService(db).state(actor,ledger.id);assert.equal(state.worker.status,'success');
result={worker_container:'PASS',uid:65532,distroless:true,healthy:true,daily_gate_simulated:'Asia/Taipei06:00',posted:1,replay_duplicate:0,zero_sum:true};
}finally{if(ledger){await db.begin(async sql=>{await sql\`SELECT id FROM ledgers WHERE id=\${ledger.id} AND owner_id=\${actor} FOR UPDATE\`;await sql\`DELETE FROM transactions WHERE ledger_id=\${ledger.id}\`;await sql\`DELETE FROM ledgers WHERE id=\${ledger.id} AND owner_id=\${actor}\`;});}if(actor){await db\`DELETE FROM audit_logs WHERE user_id=\${actor}\`;await db\`DELETE FROM users WHERE id=\${actor}\`;}await db.end();}
console.log(JSON.stringify(result));
`;
const output = run([
  ...args,
  'exec',
  '-T',
  'worker',
  '/nodejs/bin/node',
  '--input-type=module',
  '-e',
  code,
]);
process.stdout.write(output);
