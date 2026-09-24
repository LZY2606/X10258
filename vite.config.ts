import { defineConfig } from 'vite';
import { netlistApiPlugin } from './src/server/api';

export default defineConfig({
  plugins: [netlistApiPlugin()],
  server: { strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000
  }
} as never);
