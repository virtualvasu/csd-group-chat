// Keeps track of who is online right now.
class Presence {
  constructor() {
    this.usersBySocketId = new Map(); // socket id -> username
  }

  isUsernameTaken(username) {
    const lower = username.toLowerCase();
    for (const existing of this.usersBySocketId.values()) {
      if (existing.toLowerCase() === lower) return true;
    }
    return false;
  }

  add(socketId, username) {
    this.usersBySocketId.set(socketId, username);
  }

  remove(socketId) {
    const username = this.usersBySocketId.get(socketId);
    this.usersBySocketId.delete(socketId);
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
