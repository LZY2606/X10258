import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./src/server/vite-plugin-api.ts";

export default defineConfig({
  plugins: [react(), apiPlugin()],
  resolve: { alias: { "@": "/src" } },
  server: { host: "127.0.0.1", port: 5363, strictPort: true }
});
