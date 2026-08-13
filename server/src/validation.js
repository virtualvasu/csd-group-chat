const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,20}$/;
const MAX_MESSAGE_LENGTH = 500;

function validateUsername(raw) {
  const username = String(raw ?? '').trim();

  if (!username) {
    return { valid: false, reason: 'Username cannot be empty.' };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return {
      valid: false,
      reason: 'Username must be 1-20 characters: letters, numbers, spaces, "_" or "-" only.',
    };
  }

  return { valid: true, username };
}

function validateMessage(raw) {
  if (typeof raw !== 'string') {
    return { valid: false, reason: 'Message must be text.' };
  }

  const text = raw.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!text) {
    return { valid: false, reason: 'Message cannot be empty.' };
  }

  return { valid: true, text };
}

module.exports = { validateUsername, validateMessage, MAX_MESSAGE_LENGTH };
