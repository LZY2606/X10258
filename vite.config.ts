import { defineConfig } from 'vite';
import { apiPlugin } from './server/vite-plugin';

export default defineConfig({
  plugins: [apiPlugin()],
  server: { strictPort: false },
});
