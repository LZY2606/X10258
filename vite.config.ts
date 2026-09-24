import { defineConfig } from 'vite';
import { shadowApiPlugin } from './src/server/plugin';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5363, strictPort: true },
  plugins: [shadowApiPlugin()],
});
