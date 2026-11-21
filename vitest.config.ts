import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The test runner starts a Vite server. Pin it to a literal address so the
  // suite runs on machines without a resolvable `localhost` (offline CI, sandboxes).
  server: {
    host: '127.0.0.1',
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/fixtures/**', 'dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    api: false,
    reporters: ['default'],
  },
});
