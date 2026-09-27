import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { handleApiRequest } from './src/server/api';

function spiceApi(): Plugin {
  return {
    name: 'spice-equivalence-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        handleApiRequest(req, res).catch((err) => {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [spiceApi()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
