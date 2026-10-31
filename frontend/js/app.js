// ========== State ==========
const state = {
  token: localStorage.getItem('mtr_token') || null,
  user: JSON.parse(localStorage.getItem('mtr_user') || 'null'),
  socket: null,
  room: null,
  race: {
    text: '',
    typed: '',
    startTime: null,
    finished: false,
    timerInterval: null
  },
  colors: ['#38bdf8', '#f97316', '#a78bfa', '#f43f5e', '#eab308', '#14b8a6', '#ec4899', '#84cc16']
};

// ========== DOM ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const views = {
  auth: $('#view-auth'),
  lobby: $('#view-lobby'),
  room: $('#view-room'),
  race: $('#view-race'),
  result: $('#view-result')
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

// ========== Auth ==========
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    $('#loginForm').classList.toggle('hidden', !isLogin);
    $('#registerForm').classList.toggle('hidden', isLogin);
  });
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#loginUser').value.trim(),
        password: $('#loginPass').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    onAuthSuccess(data);
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#regError').textContent = '';
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#regUser').value.trim(),
        password: $('#regPass').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    onAuthSuccess(data);
  } catch (err) {
    $('#regError').textContent = err.message;
  }
});

function onAuthSuccess(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('mtr_token', data.token);
  localStorage.setItem('mtr_user', JSON.stringify(data.user));
  connectSocket();
  enterLobby();
}

$('#logoutBtn').addEventListener('click', () => {
  if (state.socket) state.socket.disconnect();
  state.token = null;
  state.user = null;
  localStorage.removeItem('mtr_token');
  localStorage.removeItem('mtr_user');
  showView('auth');
});

// ========== Socket ==========
function connectSocket() {
  if (state.socket) state.socket.disconnect();

  state.socket = io({
    auth: { token: state.token },
    transports: ['websocket', 'polling']
  });

  state.socket.on('connect', () => {
    console.log('Connected to server');
    $('#createError').textContent = '';
  });

  state.socket.on('connect_error', (err) => {
    console.error('Socket error:', err.message);
    if (err.message.includes('Authentication') || err.message.includes('token')) {
      localStorage.removeItem('mtr_token');
      localStorage.removeItem('mtr_user');
      showView('auth');
    } else {
      $('#createError').textContent = 'Connection failed. Please refresh.';
    }
  });

  state.socket.on('error_msg', ({ message }) => {
    alert(message);
    $('#joinError').textContent = message;
    $('#createError').textContent = message;
  });

  state.socket.on('room_created', ({ code, room }) => {
    console.log('Room created:', code, room);
    state.room = room;
    enterRoomView(room);
  });

  state.socket.on('joined_room', ({ room }) => {
    state.room = room;
    enterRoomView(room);
  });

  state.socket.on('player_joined', ({ room }) => {
    state.room = room;
    renderPlayers(room);
  });

  state.socket.on('player_left', ({ room }) => {
    state.room = room;
    if (!views.room.classList.contains('hidden')) {
      renderPlayers(room);
    }
  });

  state.socket.on('room_updated', ({ room }) => {
    state.room = room;
    renderPlayers(room);
  });

  state.socket.on('race_started', ({ text, room }) => {
    state.room = room;
    startRaceUI(text, room);
  });

  state.socket.on('progress_update', (data) => {
    updateClimber(data.socketId, data.progress);
  });

  state.socket.on('race_finished', ({ results }) => {
    showResults(results);
  });
}

// ========== Lobby ==========
function enterLobby() {
  $('#currentUser').textContent = state.user.username;
  showView('lobby');
  loadLeaderboard();
}

async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard?limit=15');
    const data = await res.json();
    const el = $('#leaderboard');
    if (!data.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:0.875rem">No scores yet. Be the first!</p>';
      return;
    }
    el.innerHTML = data.map((row, i) => `
      <div class="lb-row">
        <span class="rank">#${i + 1}</span>
        <span class="name">${escapeHtml(row.username)}</span>
        <span class="wpm">${Math.round(row.wpm)} WPM</span>
      </div>
    `).join('');
  } catch {
    $('#leaderboard').textContent = 'Failed to load leaderboard';
  }
}

$('#createRoomBtn').addEventListener('click', () => {
  $('#createError').textContent = '';
  if (!state.socket || !state.socket.connected) {
    $('#createError').textContent = 'Not connected. Please refresh the page.';
    connectSocket();
    return;
  }
  const customText = $('#customTextInput').value.trim();
  const maxPlayers = parseInt($('#maxPlayers').value);
  state.socket.emit('create_room', { customText, maxPlayers });
});

$('#joinRoomBtn').addEventListener('click', () => {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (code.length < 4) {
    $('#joinError').textContent = 'Enter a valid room code';
    return;
  }
  $('#joinError').textContent = '';
  if (!state.socket || !state.socket.connected) {
    $('#joinError').textContent = 'Not connected. Please refresh.';
    return;
  }
  state.socket.emit('join_room', { code });
});

// ========== Room ==========
function enterRoomView(room) {
  const code = room.code || '------';
  $('#roomCodeDisplay').textContent = code;
  $('#maxPlayersDisplay').textContent = room.maxPlayers;
  renderPlayers(room);

  const isHost = room.players.some(p => p.username === state.user.username && p.isHost);
  $('#hostControls').classList.toggle('hidden', !isHost);
  $('#guestWait').classList.toggle('hidden', isHost);

  showView('room');
}

function renderPlayers(room) {
  $('#playerCount').textContent = room.playerCount;
  const ul = $('#playersUl');
  ul.innerHTML = room.players.map(p => `
    <li>
      <span>${escapeHtml(p.username)}</span>
      ${p.isHost ? '<span class="host-badge">Host</span>' : ''}
    </li>
  `).join('');
}

$('#copyCodeBtn')?.addEventListener('click', () => {
  const code = $('#roomCodeDisplay').textContent;
  if (code && code !== '------') {
    navigator.clipboard.writeText(code).then(() => {
      const btn = $('#copyCodeBtn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  }
});

$('#updateTextBtn')?.addEventListener('click', () => {
  const text = $('#roomCustomText').value.trim();
  state.socket.emit('set_text', { text });
});

$('#startRaceBtn').addEventListener('click', () => {
  const language = $('#raceLang').value;
  const text = $('#roomCustomText').value.trim();
  if (text.length >= 20) {
    state.socket.emit('set_text', { text });
  }
  state.socket.emit('start_race', { language });
});

$('#leaveRoomBtn').addEventListener('click', () => {
  state.socket.emit('leave_room');
  state.room = null;
  enterLobby();
});

// ========== Race ==========
function startRaceUI(text, room) {
  state.race = {
    text,
    typed: '',
    startTime: null,
    finished: false,
    timerInterval: null
  };

  const container = $('#climbersContainer');
  container.innerHTML = '';
  room.players.forEach((p, idx) => {
    const lane = document.createElement('div');
    lane.className = 'climber-lane';
    lane.innerHTML = `
      <div class="climber-progress-bar"></div>
      <div class="climber-figure" id="climber-${p.socketId}" style="background:${state.colors[idx % state.colors.length]}">🧗</div>
      <div class="climber-name">${escapeHtml(p.username)}</div>
    `;
    container.appendChild(lane);
  });

  renderQuote();
  $('#typeInput').value = '';
  $('#typeInput').disabled = false;
  $('#liveWpm').textContent = '0';
  $('#liveAcc').textContent = '100%';
  $('#liveTime').textContent = '0.0s';

  showView('race');
  setTimeout(() => $('#typeInput').focus(), 100);
}

function renderQuote() {
  const box = $('#quoteDisplay');
  box.innerHTML = '';
  const chars = state.race.text.split('');
  chars.forEach((ch, i) => {
    const span = document.createElement('span');
    span.textContent = ch;
    if (i < state.race.typed.length) {
      span.className = state.race.typed[i] === ch ? 'correct' : 'incorrect';
    } else if (i === state.race.typed.length) {
      span.className = 'current';
    }
    box.appendChild(span);
  });
}

function updateClimber(socketId, progress) {
  const el = document.getElementById(`climber-${socketId}`);
  if (!el) return;
  const maxBottom = 200;
  el.style.bottom = Math.min(progress / 100 * maxBottom, maxBottom) + 'px';
}

$('#typeInput').addEventListener('input', (e) => {
  if (state.race.finished) return;

  if (!state.race.startTime) {
    state.race.startTime = Date.now();
    state.race.timerInterval = setInterval(updateLiveStats, 100);
  }

  const value = e.target.value;
  state.race.typed = value;

  let errors = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== state.race.text[i]) errors++;
  }
  const correct = value.length - errors;
  const elapsed = (Date.now() - state.race.startTime) / 1000;
  const wpm = elapsed > 0 ? Math.round((correct / 5) / (elapsed / 60)) : 0;
  const accuracy = value.length > 0 ? Math.round((correct / value.length) * 100) : 100;
  const progress = Math.min(100, (value.length / state.race.text.length) * 100);

  renderQuote();
  updateLiveStats(wpm, accuracy, elapsed);

  const finished = value.length >= state.race.text.length;
  state.socket.emit('progress', { progress, wpm, accuracy, finished });

  const myPlayer = state.room?.players.find(p => p.username === state.user.username);
  if (myPlayer) {
    updateClimber(myPlayer.socketId, progress);
  }

  if (finished) {
    state.race.finished = true;
    clearInterval(state.race.timerInterval);
    $('#typeInput').disabled = true;
  }
});

function updateLiveStats(wpm, acc, time) {
  if (wpm !== undefined) {
    $('#liveWpm').textContent = wpm;
    $('#liveAcc').textContent = acc + '%';
    $('#liveTime').textContent = time.toFixed(1) + 's';
  } else if (state.race.startTime) {
    const elapsed = (Date.now() - state.race.startTime) / 1000;
    $('#liveTime').textContent = elapsed.toFixed(1) + 's';
  }
}

// ========== Results ==========
function showResults(results) {
  const list = $('#resultList');
  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = results.map((r, i) => `
    <div class="result-row">
      <span class="pos">${medals[i] || (i + 1) + '.'}</span>
      <span class="name">${escapeHtml(r.username)}</span>
      <span class="stats">${r.wpm} WPM · ${r.accuracy}% · ${r.time}s</span>
    </div>
  `).join('');
  showView('result');
}

$('#backToLobbyBtn').addEventListener('click', () => {
  state.room = null;
  enterLobby();
});

// ========== Helpers ==========
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========== Init ==========
if (state.token && state.user) {
  connectSocket();
  enterLobby();
} else {
  showView('auth');
}
