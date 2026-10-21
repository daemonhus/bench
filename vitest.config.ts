import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The platform UI imports bench's modules as @bench/… (as in platform/ui/vite.config.ts).
  resolve: { alias: { '@bench': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.ts', 'platform/ui/src/**/*.test.ts'],
  },
});
