# Client

React + TypeScript + Tailwind + shadcn/ui frontend for the group chat, talking
to the backend over the Socket.IO contract documented in `server/README.md`.

## Develop

```bash
npm install
npm run dev
```

The dev server proxies `/socket.io` and `/health` to `http://localhost:3000`,
so run the backend (`cd ../server && npm start`) alongside it.

## Build

```bash
npm run build
```

Outputs to `dist/`, which the Express server serves in production (see
`server/server.js`).
