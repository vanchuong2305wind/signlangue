import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The Web Speech API only runs in a secure context. `http://localhost` is one,
// so plain HTTP is the better default for desktop work — Chrome can refuse the
// microphone on an origin whose certificate it does not trust, which is what a
// self-signed dev certificate is. Opening the app on a phone over the LAN is the
// case that needs real HTTPS, because `http://192.168.x.x` is not a secure
// context: start the server with VITE_HTTPS=1 for that.
const useHttps = process.env.VITE_HTTPS === '1';
// Overridable so the backend can move when port 8000 is already taken.
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8000';

export default defineConfig({
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
