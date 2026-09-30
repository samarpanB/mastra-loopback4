import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mastra-loopback',
    // Keep the default per-file isolation: the published suite mocks `zod` and
    // `@mastra/core/vector` at module scope, which must not leak into other files.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // The published suite calls `vi.mock(...)` at module scope. Vitest only hoists
    // mocks in files it transforms, and node_modules is externalized by default,
    // so the suite must be inlined for its own test context to work.
    server: {
      deps: {
        inline: ['@mastra/server-adapters-test-suite'],
      },
    },
  },
});
