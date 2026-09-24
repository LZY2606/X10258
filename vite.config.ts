import { defineConfig } from 'vite';
import { apiPlugin } from './src/server/apiPlugin';

export default defineConfig({
  plugins: [apiPlugin()],
  server: { strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
