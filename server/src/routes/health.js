const { Router } = require('express');

// What the load balancer polls to decide whether this backend should be sent
// traffic at all.
//
// It reports the database too, because a backend that cannot reach its database
// is not healthy even though it looks it: reads are served from memory and keep
// answering perfectly, while every write fails. That exact state happened —
// mongod was killed on one machine and the backend went on passing health
// checks for a long time, so the balancer kept routing writes to a process that
// could not store a single one of them.
//
// Answering 503 here takes the machine out of rotation until its database comes
// back, which is what the balancer's health checking was for in the first place.
function createHealthRouter(presence, store = null) {
  const router = Router();

  router.get('/health', (req, res) => {
    const databaseReachable = store ? store.dbHealthy !== false : true;

    res.status(databaseReachable ? 200 : 503).json({
      status: databaseReachable ? 'ok' : 'degraded',
      database: databaseReachable ? 'connected' : 'unreachable',
      uptimeSeconds: Math.round(process.uptime()),
      onlineUsers: presence.count,
    });
  });

  return router;
}

module.exports = { createHealthRouter };
