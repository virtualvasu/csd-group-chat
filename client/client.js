const socket = io();

const joinScreen = document.getElementById('join-screen');
const chatScreen = document.getElementById('chat-screen');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const messages = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const userList = document.getElementById('user-list');
const typingIndicator = document.getElementById('typing-indicator');

// Stop telling others we are typing once the input has been idle this long.
const TYPING_IDLE_MS = 2000;

let username = '';
let hasJoined = false;
let isTyping = false;
let typingIdleTimer = null;
const typingUsers = new Set();

function joinChat() {
  const value = usernameInput.value.trim();
  if (!value) return;

  joinError.classList.add('hidden');
  socket.emit('join', value);
}

joinBtn.addEventListener('click', joinChat);
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinChat();
});

// Only tells the server when our typing state actually changes, so a burst of
// keystrokes results in a single event.
function setTyping(typing) {
  clearTimeout(typingIdleTimer);

  if (typing) {
    typingIdleTimer = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
  }
  if (typing === isTyping) return;

  isTyping = typing;
  socket.emit('typing', typing);
}

messageInput.addEventListener('input', () => {
  setTyping(messageInput.value.trim().length > 0);
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', text);
  messageInput.value = '';
  setTyping(false);
});

function renderTypingIndicator() {
  const names = Array.from(typingUsers);

  if (names.length === 0) {
    typingIndicator.textContent = '';
  } else if (names.length === 1) {
    typingIndicator.textContent = `${names[0]} is typing...`;
  } else if (names.length === 2) {
    typingIndicator.textContent = `${names[0]} and ${names[1]} are typing...`;
  } else {
    typingIndicator.textContent = 'Several people are typing...';
  }
}

function appendMessage({ username: from, text, timestamp }) {
  const el = document.createElement('div');
  el.classList.add('message');
  if (from === username) el.classList.add('own');

  el.innerHTML = `<span class="meta">${escapeHtml(from)} · ${formatTime(timestamp)}</span><span class="text">${escapeHtml(text)}</span>`;

  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function appendSystemMessage(text, timestamp = Date.now()) {
  const el = document.createElement('div');
  el.classList.add('system-message');
  el.textContent = `${text} · ${formatTime(timestamp)}`;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

socket.on('chat-message', (message) => {
  // A sent message ends that user's typing turn.
  typingUsers.delete(message.username);
  renderTypingIndicator();
  appendMessage(message);
});

socket.on('user-typing', ({ username: from, isTyping: typing }) => {
  if (typing) {
    typingUsers.add(from);
  } else {
    typingUsers.delete(from);
  }
  renderTypingIndicator();
});

socket.on('join-success', ({ username: confirmed }) => {
  username = confirmed;

  if (!hasJoined) {
    hasJoined = true;
    joinScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    messageInput.focus();
  } else {
    appendSystemMessage('Reconnected to the chat.');
  }
});

socket.on('join-error', ({ message }) => {
  if (!hasJoined) {
    joinError.textContent = message;
    joinError.classList.remove('hidden');
  } else {
    appendSystemMessage(`Reconnect failed: ${message}`);
  }
});

socket.on('message-error', ({ message }) => {
  appendSystemMessage(`Message not sent: ${message}`);
});

socket.on('server-error', ({ message }) => {
  appendSystemMessage(`Error: ${message}`);
});

socket.on('user-joined', ({ username: joined, timestamp }) => {
  appendSystemMessage(`${joined} joined the chat`, timestamp);
});

socket.on('user-left', ({ username: left, timestamp }) => {
  typingUsers.delete(left);
  renderTypingIndicator();
  appendSystemMessage(`${left} left the chat`, timestamp);
});

socket.on('online-users', (users) => {
  userList.innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.textContent = u;
    userList.appendChild(li);
  });
});

socket.on('disconnect', () => {
  // Typing state is per-connection on the server, so drop what we know locally.
  isTyping = false;
  typingUsers.clear();
  renderTypingIndicator();
  appendSystemMessage('Disconnected from server. Trying to reconnect...');
});

socket.on('connect', () => {
  if (hasJoined && username) socket.emit('join', username);
});
