import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@bench': path.resolve(__dirname, '../../src'),
    },
    dedupe: ['react', 'react-dom', 'zustand', 'refractor', 'diff-match-patch'],
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 3000),
    strictPort: true,
    proxy: {
      '/api': { target: process.env.PLATFORM_API ?? 'http://localhost:8080', changeOrigin: true },
      '/mcp': { target: process.env.PLATFORM_API ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
});
