import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// The dev server runs over HTTPS on purpose.
//
// Signing keys come from WebCrypto, and browsers only expose `crypto.subtle`
// in a secure context. `localhost` counts as one, but the Network URL this
// server prints for other devices — http://<lan-ip>:3000 — does not, so
// without TLS everyone except the person running the server would be unable to
// create an identity and would be refused at login.
//
// The certificate is self-signed, so each device has to accept a browser
// warning once. That is the whole cost of it.
// Which chat server to proxy to. Overridable so a second instance can be run
// against a throwaway database — useful for capturing a demo without touching
// the real room.
const chatServer = process.env.CHAT_SERVER_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 3000,
    strictPort: true,
    proxy: {
      '/socket.io': {
        target: chatServer,
        ws: true,
      },
      '/health': chatServer,
    },
  },
})
