import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/*/src/*.db.test.ts',
      'apps/server/src/*.db.test.ts',
      'tools/*/src/*.db.test.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
