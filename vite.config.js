import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/odoo/',
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        secure: false,
      },
      '/odoo-proxy': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        secure: false,
      },
      '/squadsm': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        secure: false,
      },
      '/squadts': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        secure: false,
      },
      '/squad-atlas': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
