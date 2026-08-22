const { Router } = require('express');

// Load-balancer assignment only: not used by the chat app itself.
//
// /health does no real work, so it can't show a single backend becoming a
// bottleneck under concurrent load — Node can answer it instantly no matter
// how many requests arrive at once. This endpoint burns CPU synchronously
// for `busyMs` milliseconds per request instead. Because Node has one
// thread for JS execution, that busy-wait blocks the event loop, so
// concurrent requests to a single process genuinely serialize behind one
// another. Three separate processes (Sys2/3/4) then have three independent
// event loops and can do three times the work in parallel, which is what
// actually demonstrates the load balancer's benefit.
function createLoadTestRouter() {
  const router = Router();

  router.get('/lb-test', (req, res) => {
    const busyMs = Number(req.query.busy) || 20;
    const start = Date.now();
    while (Date.now() - start < busyMs) {
      // Deliberately busy-blocking the event loop, not sleeping.
    }

    res.json({
      backend: process.env.PORT || 'unknown',
      busy_ms: busyMs,
      message: 'ok',
    });
  });

  return router;
}

module.exports = { createLoadTestRouter };
