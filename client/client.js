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

let username = '';
let hasJoined = false;

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

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', text);
  messageInput.value = '';
});

function appendMessage({ username: from, text, timestamp }) {
  const el = document.createElement('div');
  el.classList.add('message');
  if (from === username) el.classList.add('own');

  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<span class="meta">${escapeHtml(from)} · ${time}</span><span class="text">${escapeHtml(text)}</span>`;

  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.classList.add('system-message');
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

socket.on('chat-message', appendMessage);

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

socket.on('user-joined', ({ username: joined }) => {
  appendSystemMessage(`${joined} joined the chat`);
});

socket.on('user-left', ({ username: left }) => {
  appendSystemMessage(`${left} left the chat`);
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
  appendSystemMessage('Disconnected from server. Trying to reconnect...');
});

socket.on('connect', () => {
  if (hasJoined && username) socket.emit('join', username);
});
