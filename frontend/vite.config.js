import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.API_PORT || 8787;

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: { '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
