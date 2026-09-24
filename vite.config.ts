import { defineConfig } from 'vite';
import { apiPlugin } from './src/server/api';

export default defineConfig({
  plugins: [apiPlugin()],
  server: { strictPort: true },
});
