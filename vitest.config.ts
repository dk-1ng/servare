import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    globalSetup: ['test/fixtures/global-setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
