import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { host: '127.0.0.1', port: 5363, strictPort: true },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
