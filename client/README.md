# Client

React + TypeScript + Tailwind + shadcn/ui frontend for the group chat, talking
to the backend over the Socket.IO contract documented in `server/README.md`.

Requires **Node ^20.19.0 or >=22.12.0** (Vite 8's minimum). On an older Node
(e.g. 18.x) `npm run dev`/`build` fails with a `styleText` import error from
`node:util` — install a newer Node (`nvm install 22 && nvm use 22`) first.

## Develop

```bash
npm install
npm run dev
```

The dev server runs on port **3000** and proxies `/socket.io` and `/health` to
the backend on `http://localhost:4000`, so run the backend
(`cd ../server && npm start`) alongside it.

The port is fixed (`strictPort`), so Vite fails instead of quietly moving to
another port if 3000 is busy — the proxy setup depends on it being 3000. If you
hit "Port 3000 is already in use", something else has it: check with
`ss -ltnp | grep :3000`.

## Build

```bash
npm run build
```

Outputs to `dist/`, which the Express server serves in production (see
`server/server.js`).
