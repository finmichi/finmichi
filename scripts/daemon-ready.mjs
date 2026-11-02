// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
// Only the caller-created, labelled synthetic daemon is accepted.
export async function waitForDaemon(
  daemon,
  outerEnv,
  innerEnv,
  timeoutMs = 180000,
) {
  const run = (args, env) =>
    execFileSync('docker', args, {
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = JSON.parse(run(['inspect', daemon], outerEnv))[0];
    if (state.Config.Labels['finmichi.synthetic'] !== 'd0')
      throw new Error('Not a synthetic daemon');
    if (!state.State.Running)
      throw new Error('Isolated daemon exited before readiness');
    try {
      run(['info'], innerEnv);
      return Date.now() - started;
    } catch {
      await wait(1000);
    }
  }
  throw new Error('Isolated daemon readiness timed out after 180 seconds');
}
export function daemonDiagnostics(daemon, outerEnv) {
  try {
    const result = spawnSync('docker', ['logs', '--tail', '100', daemon], {
      env: outerEnv,
      encoding: 'utf8',
      timeout: 5000,
    });
    console.error(
      'Isolated DinD log tail:\n' +
        String(result.stdout ?? '') +
        String(result.stderr ?? ''),
    );
  } catch (error) {
    console.error(
      'Isolated DinD log tail:\n' +
        String(error.stdout ?? '') +
        String(error.stderr ?? ''),
    );
  }
}
