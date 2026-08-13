const { Router } = require('express');

function createHealthRouter(presence) {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      onlineUsers: presence.count,
    });
  });

  return router;
}

module.exports = { createHealthRouter };
