// SPDX-License-Identifier: AGPL-3.0-only
import {
  connect,
  migrate,
  operationalErrorClass,
  operationalErrorCode,
} from '@finmichi/db';
import { settings, createApp } from './app.js';
let stage: 'config_invalid' | 'migration_pending' | 'app_failed' =
  'config_invalid';
let db: ReturnType<typeof connect> | undefined;
try {
  const config = settings();
  db = connect(config.databaseUrl);
  stage = 'migration_pending';
  await migrate(db);
  stage = 'app_failed';
  const app = await createApp(config, db);
  app.addHook('onClose', async () => {
    await db?.end();
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void app.close();
    });
  await app.listen({
    port: Number(process.env.PORT ?? '8080'),
    host: process.env.HOST ?? '0.0.0.0',
  });
} catch (error) {
  const code = operationalErrorCode(error, stage);
  console.error(
    JSON.stringify({
      event: 'app.start',
      outcome: 'error',
      code,
      ...(code === 'app_failed'
        ? { error_class: operationalErrorClass(error) }
        : {}),
    }),
  );
  await db?.end();
  process.exitCode = 1;
}
