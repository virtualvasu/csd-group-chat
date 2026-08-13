const WINDOW_MS = 3000;
const MAX_EVENTS_PER_WINDOW = 5;

// Limits how many messages one user can send in a short time.
class RateLimiter {
  constructor() {
    this.hits = new Map(); // socket id -> list of message times
  }

  allow(socketId) {
    const now = Date.now();
    const timestamps = (this.hits.get(socketId) || []).filter(
      (t) => now - t < WINDOW_MS
    );

    if (timestamps.length >= MAX_EVENTS_PER_WINDOW) {
      this.hits.set(socketId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.hits.set(socketId, timestamps);
    return true;
  }

  clear(socketId) {
    this.hits.delete(socketId);
  }
}

module.exports = { RateLimiter };
