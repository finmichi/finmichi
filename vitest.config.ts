import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'tools/**/*.test.ts',
    ],
    exclude: ['**/*.db.test.ts', '**/node_modules/**', '**/dist/**'],
    maxWorkers: 2,
  },
});
