// Keeps track of who is online right now.
class Presence {
  constructor() {
    this.usersBySocketId = new Map(); // socket id -> username
    this.recentlyDisconnected = new Map(); // lower-case username -> timestamp
  }

  isUsernameTaken(username) {
    const lower = String(username ?? '').trim().toLowerCase();
    if (!lower) return false;

    for (const existing of this.usersBySocketId.values()) {
      if (existing.toLowerCase() === lower) return true;
    }
    return false;
  }

  markDisconnected(username) {
    const lower = String(username ?? '').trim().toLowerCase();
    if (!lower) return;
    this.recentlyDisconnected.set(lower, Date.now());
  }

  hasRecentDisconnect(username) {
    const lower = String(username ?? '').trim().toLowerCase();
    if (!lower) return false;

    const timestamp = this.recentlyDisconnected.get(lower);
    if (!timestamp) return false;

    const fresh = Date.now() - timestamp < 10000;
    if (!fresh) {
      this.recentlyDisconnected.delete(lower);
      return false;
    }

    return true;
  }

  reclaimUsername(socketId, username) {
    const lower = String(username ?? '').trim().toLowerCase();
    if (!lower || !this.hasRecentDisconnect(username)) return false;

    for (const [existingSocketId, existingUsername] of this.usersBySocketId.entries()) {
      if (existingUsername.toLowerCase() === lower) {
        this.usersBySocketId.delete(existingSocketId);
        break;
      }
    }

    this.recentlyDisconnected.delete(lower);
    this.usersBySocketId.set(socketId, username);
    return true;
  }

  add(socketId, username) {
    this.usersBySocketId.set(socketId, username);
    this.recentlyDisconnected.delete(username.toLowerCase());
  }

  remove(socketId) {
    const username = this.usersBySocketId.get(socketId);
    this.usersBySocketId.delete(socketId);
    if (username) {
      this.markDisconnected(username);
    }
    return username;
  }

  get(socketId) {
    return this.usersBySocketId.get(socketId);
  }

  list() {
    return Array.from(this.usersBySocketId.values());
  }

  get count() {
    return this.usersBySocketId.size;
  }
}

module.exports = { Presence };
