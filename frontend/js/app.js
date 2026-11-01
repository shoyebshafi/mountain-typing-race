// ========== State ==========
const state = {
  token: localStorage.getItem('mtr_token') || null,
  user: JSON.parse(localStorage.getItem('mtr_user') || 'null'),
  socket: null,
  room: null,
  mode: 'idle', // 'idle' | 'race' | 'practice'
  lbLang: 'en',
  sound: localStorage.getItem('mtr_sound') !== 'off',
  lastPractice: null,
  race: newRaceState(),
  colors: ['#38bdf8', '#f97316', '#a78bfa', '#f43f5e', '#eab308', '#14b8a6', '#ec4899', '#84cc16']
};

function newRaceState(text = '') {
  const normalized = normalize(text);
  return {
    text: normalized,
    textArr: Array.from(normalized),
    typed: '',
    startTime: null,
    running: false,
    finished: false,
    timerInterval: null,
    cdTimer: null,
    sendTimer: null,
    lastSent: 0,
    lastLen: 0,
    maxLen: 0,
    wrong: new Set()
  };
}

// ========== DOM ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const views = {
  auth: $('#view-auth'),
  lobby: $('#view-lobby'),
  profile: $('#view-profile'),
  room: $('#view-room'),
  race: $('#view-race'),
  result: $('#view-result')
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

function isVisible(name) {
  return !views[name].classList.contains('hidden');
}

// ========== Helpers ==========
// NFC normalization so Bangla vowel signs typed in a different code point order still match.
function normalize(s) {
  return (s || '').normalize('NFC');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

function langName(l) {
  return l === 'bn' ? 'Bangla' : 'English';
}

function formatDate(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function amHost() {
  return !!(state.room && state.room.players.some((p) => p.username === state.user.username && p.isHost));
}

// ========== Sound ==========
let audioCtx = null;
function beep(freq = 440, dur = 0.08, type = 'sine', vol = 0.06, delay = 0) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  } catch { /* audio not available */ }
}
const sfx = {
  key: () => beep(900, 0.03, 'square', 0.012),
  error: () => beep(150, 0.12, 'sawtooth', 0.035),
  tick: () => beep(520, 0.12, 'sine', 0.07),
  go: () => beep(880, 0.3, 'sine', 0.09),
  finish: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.18, 'triangle', 0.07, i * 0.12))
};

function renderSoundBtn() {
  $('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
}
$('#soundBtn').addEventListener('click', () => {
  state.sound = !state.sound;
  localStorage.setItem('mtr_sound', state.sound ? 'on' : 'off');
  renderSoundBtn();
  if (state.sound) sfx.tick();
});
renderSoundBtn();

// ========== Auth ==========
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
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
      body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value })
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
      body: JSON.stringify({ username: $('#regUser').value.trim(), password: $('#regPass').value })
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

function logout() {
  resetRace();
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.token = null;
  state.user = null;
  state.room = null;
  localStorage.removeItem('mtr_token');
  localStorage.removeItem('mtr_user');
  showView('auth');
}
$('#logoutBtn').addEventListener('click', logout);

// ========== Socket ==========
function connectSocket() {
  if (state.socket) state.socket.disconnect();

  state.socket = io({
    auth: { token: state.token },
    transports: ['websocket', 'polling']
  });
  const socket = state.socket;

  socket.on('connect', () => {
    console.log('Connected to server');
    $('#createError').textContent = '';
  });

  socket.on('connect_error', (err) => {
    console.error('Socket error:', err.message);
    if (err.message.includes('Authentication') || err.message.includes('token')) {
      logout();
      toast('Your session expired. Please log in again.');
    } else {
      $('#createError').textContent = 'Connection failed. Please refresh.';
    }
  });

  socket.on('disconnect', () => {
    if (state.mode !== 'idle' || state.room) {
      resetRace();
      state.room = null;
      if (state.token) {
        toast('Connection lost. Returning to the lobby.');
        enterLobby();
      }
    }
  });

  socket.on('error_msg', ({ message }) => {
    toast(message);
    if (isVisible('lobby')) $('#joinError').textContent = message;
  });

  // ----- Rooms -----
  socket.on('room_created', ({ room }) => {
    state.room = room;
    enterRoomView(room);
  });

  socket.on('joined_room', ({ room }) => {
    state.room = room;
    enterRoomView(room);
  });

  socket.on('player_joined', ({ room }) => {
    state.room = room;
    if (isVisible('room')) renderPlayers(room);
  });

  socket.on('player_left', ({ room, leftUsername }) => {
    state.room = room;
    if (isVisible('room')) {
      renderPlayers(room);
      refreshHostControls(room);
    }
    if (isVisible('result')) updateResultButtons();
    if (isVisible('race') && state.mode === 'race') {
      const leftPlayer = document.querySelector(`.climber-lane[data-user="${CSS.escape(leftUsername || '')}"]`);
      if (leftPlayer) leftPlayer.classList.add('left');
    }
  });

  socket.on('room_updated', ({ room }) => {
    state.room = room;
    if (isVisible('room')) renderPlayers(room);
  });

  // ----- Race flow -----
  socket.on('race_starting', ({ text, room }) => {
    state.room = room;
    state.mode = 'race';
    setupRace(text, room.players);
  });

  socket.on('countdown', ({ n }) => showCountdown(n));

  socket.on('race_go', () => {
    if (state.mode !== 'race') return;
    showCountdown(0);
    startTyping();
  });

  socket.on('progress_update', (data) => {
    if (state.mode !== 'race') return;
    const mine = data.socketId === socket.id;
    updateClimber(data.socketId, mine ? undefined : data.progress, data);
  });

  socket.on('race_finished', ({ results, room }) => {
    state.room = room;
    finishRaceTimers();
    showResults(results, 'race');
  });

  socket.on('rematch_ready', ({ room }) => {
    state.room = room;
    state.mode = 'idle';
    resetRace();
    enterRoomView(room);
  });

  // ----- Practice -----
  socket.on('practice_ready', ({ text }) => {
    state.mode = 'practice';
    setupRace(text, [{ socketId: 'me', username: state.user.username }]);
    localCountdown(startTyping);
  });

  socket.on('practice_result', (r) => {
    showResults(
      [{ username: state.user.username, wpm: r.wpm, accuracy: r.accuracy, rank: 1, time: r.time, finished: true }],
      'practice'
    );
  });
}

// ========== Lobby ==========
function enterLobby() {
  resetRace();
  state.mode = 'idle';
  $('#currentUser').textContent = state.user.username;
  showView('lobby');
  loadLeaderboard();
}

$$('.lb-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.lb-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.lbLang = btn.dataset.lang;
    loadLeaderboard();
  });
});

async function loadLeaderboard() {
  const el = $('#leaderboard');
  try {
    const res = await fetch(`/api/leaderboard?lang=${state.lbLang}&limit=15`);
    const data = await res.json();
    if (!data.length) {
      el.innerHTML = `<p style="color:var(--muted);font-size:0.875rem">No ${langName(state.lbLang)} scores yet. Be the first!</p>`;
      return;
    }
    el.innerHTML = data.map((row, i) => `
      <div class="lb-row ${row.username === state.user?.username ? 'me' : ''}">
        <span class="rank">#${i + 1}</span>
        <span class="name">${escapeHtml(row.username)}</span>
        <span class="acc">${Math.round(row.accuracy)}%</span>
        <span class="wpm">${Math.round(row.wpm)} WPM</span>
      </div>
    `).join('');
  } catch {
    el.textContent = 'Failed to load leaderboard';
  }
}

$('#createRoomBtn').addEventListener('click', () => {
  $('#createError').textContent = '';
  if (!state.socket || !state.socket.connected) {
    $('#createError').textContent = 'Not connected. Please refresh the page.';
    connectSocket();
    return;
  }
  state.socket.emit('create_room', {
    customText: $('#customTextInput').value.trim(),
    maxPlayers: parseInt($('#maxPlayers').value)
  });
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

$('#practiceStartBtn').addEventListener('click', () => {
  $('#practiceError').textContent = '';
  if (!state.socket || !state.socket.connected) {
    $('#practiceError').textContent = 'Not connected. Please refresh the page.';
    return;
  }
  const customText = $('#practiceCustomText').value.trim();
  if (customText.length > 0 && customText.length < 20) {
    $('#practiceError').textContent = 'Custom text needs at least 20 characters (or leave it empty).';
    return;
  }
  state.lastPractice = { language: $('#practiceLang').value, customText };
  sfx.tick();
  state.socket.emit('practice_start', state.lastPractice);
});

// ========== Profile ==========
$('#profileBtn').addEventListener('click', openProfile);
$('#backFromProfileBtn').addEventListener('click', enterLobby);

async function openProfile() {
  $('#profileName').textContent = state.user.username;
  $('#profileStats').innerHTML = '<p class="hint">Loading...</p>';
  $('#profileChart').innerHTML = '';
  $('#profileRecent').innerHTML = '';
  showView('profile');
  try {
    const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + state.token } });
    if (res.status === 401) {
      logout();
      toast('Your session expired. Please log in again.');
      return;
    }
    const data = await res.json();
    renderProfile(data.stats);
  } catch {
    $('#profileStats').innerHTML = '<p class="hint">Failed to load profile.</p>';
  }
}

function renderProfile(stats) {
  const b = stats.best || {};
  const races = b.races || 0;
  const num = (v, suffix = '') => (v === null || v === undefined ? '—' : Math.round(v) + suffix);
  const lang = (l) => (stats.byLanguage || []).find((x) => x.language === l);

  const cards = [
    ['Best WPM', num(b.best_wpm)],
    ['Average WPM', num(b.avg_wpm)],
    ['Avg Accuracy', num(b.avg_accuracy, '%')],
    ['Games Played', races],
    ['Race Wins', b.wins || 0],
    ['Best English', lang('en') ? Math.round(lang('en').best_wpm) : '—'],
    ['Best Bangla', lang('bn') ? Math.round(lang('bn').best_wpm) : '—']
  ];
  $('#profileStats').innerHTML = cards
    .map(([k, v]) => `<div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  renderChart(stats.recent || []);
  renderRecent(stats.recent || []);
}

function renderChart(recent) {
  const el = $('#profileChart');
  const pts = [...recent].reverse(); // oldest -> newest
  if (pts.length < 2) {
    el.innerHTML = '<p class="hint">Finish at least 2 games to see your WPM graph.</p>';
    return;
  }
  const W = 640, H = 220, pl = 40, pr = 16, pt = 16, pb = 30;
  const max = Math.max(10, Math.ceil(Math.max(...pts.map((p) => p.wpm)) / 10) * 10);
  const x = (i) => pl + (i / (pts.length - 1)) * (W - pl - pr);
  const y = (v) => pt + (1 - v / max) * (H - pt - pb);

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const v = Math.round((max * g) / 4);
    const yy = y(v);
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" class="chart-grid"/>` +
            `<text x="${pl - 6}" y="${yy + 4}" class="chart-label" text-anchor="end">${v}</text>`;
  }
  const line = pts.map((p, i) => `${x(i)},${y(p.wpm)}`).join(' ');
  const area = `${x(0)},${y(0)} ${line} ${x(pts.length - 1)},${y(0)}`;
  const dots = pts.map((p, i) =>
    `<circle cx="${x(i)}" cy="${y(p.wpm)}" r="4" class="chart-dot"><title>${Math.round(p.wpm)} WPM · ${Math.round(p.accuracy)}% · ${langName(p.language)} · ${formatDate(p.played_at)}</title></circle>`
  ).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="WPM over your recent games">
      ${grid}
      <polygon points="${area}" class="chart-area"/>
      <polyline points="${line}" class="chart-line"/>
      ${dots}
      <text x="${pl}" y="${H - 8}" class="chart-label">Oldest</text>
      <text x="${W - pr}" y="${H - 8}" class="chart-label" text-anchor="end">Latest</text>
    </svg>`;
}

function renderRecent(recent) {
  const el = $('#profileRecent');
  if (!recent.length) {
    el.innerHTML = '<p class="hint">No games yet. Try Practice Mode!</p>';
    return;
  }
  const modeLabel = { race: 'Race', practice: 'Practice', custom: 'Custom text' };
  el.innerHTML = `
    <table class="recent">
      <thead><tr><th>Date</th><th>Type</th><th>Language</th><th>WPM</th><th>Accuracy</th><th>Time</th><th>Rank</th></tr></thead>
      <tbody>
        ${recent.map((r) => `
          <tr>
            <td>${formatDate(r.played_at)}</td>
            <td>${modeLabel[r.mode] || r.mode}</td>
            <td>${langName(r.language)}</td>
            <td class="wpm">${Math.round(r.wpm)}</td>
            <td>${Math.round(r.accuracy)}%</td>
            <td>${Number(r.time_seconds).toFixed(1)}s</td>
            <td>${r.rank ? '#' + r.rank : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ========== Room ==========
function enterRoomView(room) {
  $('#roomCodeDisplay').textContent = room.code || '------';
  $('#maxPlayersDisplay').textContent = room.maxPlayers;
  renderPlayers(room);
  refreshHostControls(room);
  showView('room');
}

function refreshHostControls(room) {
  const isHost = room.players.some((p) => p.username === state.user.username && p.isHost);
  $('#hostControls').classList.toggle('hidden', !isHost);
  $('#guestWait').classList.toggle('hidden', isHost);
}

function renderPlayers(room) {
  $('#playerCount').textContent = room.playerCount;
  $('#playersUl').innerHTML = room.players.map((p) => `
    <li>
      <span>${escapeHtml(p.username)}</span>
      ${p.isHost ? '<span class="host-badge">Host</span>' : ''}
    </li>
  `).join('');
}

$('#copyCodeBtn').addEventListener('click', () => {
  const code = $('#roomCodeDisplay').textContent;
  if (code && code !== '------') {
    navigator.clipboard.writeText(code).then(() => {
      const btn = $('#copyCodeBtn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  }
});

$('#updateTextBtn').addEventListener('click', () => {
  state.socket.emit('set_text', { text: $('#roomCustomText').value.trim() });
  toast('Race text updated');
});

$('#startRaceBtn').addEventListener('click', () => {
  const text = $('#roomCustomText').value.trim();
  if (text.length >= 20) state.socket.emit('set_text', { text });
  state.socket.emit('start_race', { language: $('#raceLang').value });
});

$('#leaveRoomBtn').addEventListener('click', () => {
  state.socket.emit('leave_room');
  state.room = null;
  enterLobby();
});

// ========== Race ==========
function setupRace(text, players) {
  resetRace();
  state.race = newRaceState(text);

  const container = $('#climbersContainer');
  container.innerHTML = '';
  players.forEach((p, idx) => {
    const id = p.socketId;
    const isMe = state.mode === 'practice' ? true : id === state.socket.id;
    const lane = document.createElement('div');
    lane.className = 'climber-lane';
    lane.dataset.user = p.username;
    lane.innerHTML = `
      <div class="climber-rope"><div class="climber-rope-fill" id="rope-${id}"></div></div>
      <div class="climber-figure ${isMe ? 'me' : ''}" id="climber-${id}" data-progress="0" style="background:${state.colors[idx % state.colors.length]}">🧗<span class="climber-rank hidden" id="rank-${id}"></span></div>
      <div class="climber-label">
        <span class="climber-name">${escapeHtml(p.username)}${isMe ? ' (you)' : ''}</span>
        <span class="climber-wpm" id="wpm-${id}">0 WPM</span>
      </div>
    `;
    container.appendChild(lane);
  });

  renderQuote();
  const input = $('#typeInput');
  input.value = '';
  input.disabled = true;
  input.placeholder = 'Get ready...';
  $('#liveWpm').textContent = '0';
  $('#liveAcc').textContent = '100%';
  $('#liveTime').textContent = '0.0s';
  $('#finishMsg').classList.add('hidden');
  $('#quoteDisplay').scrollTop = 0;
  showView('race');
}

function myLaneId() {
  return state.mode === 'practice' ? 'me' : state.socket.id;
}

function showCountdown(n) {
  const el = $('#countdown');
  el.textContent = n > 0 ? String(n) : 'GO!';
  el.classList.remove('hidden', 'pop');
  void el.offsetWidth; // restart the animation
  el.classList.add('pop');
  if (n > 0) {
    sfx.tick();
  } else {
    sfx.go();
    setTimeout(() => $('#countdown').classList.add('hidden'), 700);
  }
}

function localCountdown(onGo) {
  let n = 3;
  showCountdown(n);
  const step = () => {
    n--;
    if (n > 0) {
      showCountdown(n);
      state.race.cdTimer = setTimeout(step, 1000);
    } else {
      showCountdown(0);
      onGo();
    }
  };
  state.race.cdTimer = setTimeout(step, 1000);
}

function startTyping() {
  const r = state.race;
  r.running = true;
  r.startTime = Date.now();
  const input = $('#typeInput');
  input.disabled = false;
  input.value = '';
  input.placeholder = 'Start typing here...';
  input.focus();
  r.timerInterval = setInterval(tickTime, 100);
}

function tickTime() {
  const r = state.race;
  if (!r.startTime || r.finished) return;
  $('#liveTime').textContent = ((Date.now() - r.startTime) / 1000).toFixed(1) + 's';
}

function renderQuote(typedArr = []) {
  const box = $('#quoteDisplay');
  const chars = state.race.textArr;
  const frag = document.createDocumentFragment();
  let currentEl = null;
  chars.forEach((ch, i) => {
    const span = document.createElement('span');
    span.textContent = ch;
    if (i < typedArr.length) {
      span.className = typedArr[i] === ch ? 'correct' : 'incorrect';
    } else if (i === typedArr.length) {
      span.className = 'current';
      currentEl = span;
    }
    frag.appendChild(span);
  });
  box.innerHTML = '';
  box.appendChild(frag);

  // keep the current character in view without scrolling the whole page
  if (currentEl) {
    const top = currentEl.offsetTop;
    if (top > box.scrollTop + box.clientHeight - 50 || top < box.scrollTop) {
      box.scrollTop = Math.max(0, top - 40);
    }
  }
}

function updateClimber(id, progress, extra = {}) {
  const el = document.getElementById(`climber-${id}`);
  if (!el) return;

  if (progress !== undefined) {
    const lane = el.parentElement;
    const max = Math.max(lane.clientHeight - 44, 0);
    el.style.bottom = (Math.min(progress, 100) / 100) * max + 'px';
    const rope = document.getElementById(`rope-${id}`);
    if (rope) rope.style.height = Math.min(progress, 100) + '%';

    const prev = parseFloat(el.dataset.progress || '0');
    if (progress > prev) {
      el.classList.add('moving');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('moving'), 350);
    }
    el.dataset.progress = String(progress);
  }

  if (extra.wpm !== undefined && id !== myLaneId()) {
    const w = document.getElementById(`wpm-${id}`);
    if (w) w.textContent = extra.wpm + ' WPM';
  }
  if (extra.finished) {
    el.classList.add('summit');
    if (extra.rank) {
      const badge = document.getElementById(`rank-${id}`);
      if (badge) {
        badge.textContent = '#' + extra.rank;
        badge.classList.remove('hidden');
      }
    }
  }
}

function sendProgress(force = false) {
  if (state.mode !== 'race') return;
  const r = state.race;
  const emit = () => {
    r.sendTimer = null;
    r.lastSent = Date.now();
    state.socket.emit('progress', { typed: r.typed, maxLen: r.maxLen, mistakes: r.wrong.size });
  };
  const now = Date.now();
  if (force) {
    clearTimeout(r.sendTimer);
    emit();
  } else if (now - r.lastSent >= 120) {
    clearTimeout(r.sendTimer);
    emit();
  } else if (!r.sendTimer) {
    r.sendTimer = setTimeout(emit, 120 - (now - r.lastSent));
  }
}

const typeInput = $('#typeInput');

// No pasting / dropping / Enter: the race must be typed by hand.
['paste', 'drop', 'cut'].forEach((evt) => typeInput.addEventListener(evt, (e) => e.preventDefault()));
typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

typeInput.addEventListener('input', () => {
  const r = state.race;
  if (!r.running || r.finished) return;

  const value = normalize(typeInput.value);
  const typedArr = Array.from(value);
  r.typed = value;

  // A mistake counts once the cursor has moved past a wrong character
  // (so half-typed Bangla vowel signs at the cursor are never counted as errors).
  for (let i = 0; i < typedArr.length - 1; i++) {
    if (typedArr[i] !== r.textArr[i]) r.wrong.add(i);
  }
  r.maxLen = Math.max(r.maxLen, typedArr.length);

  if (typedArr.length > r.lastLen) {
    const idx = typedArr.length - 1;
    (typedArr[idx] === r.textArr[idx] ? sfx.key : sfx.error)();
  }
  r.lastLen = typedArr.length;

  // Correct characters from the start; stops at the first mistake
  let prefix = 0;
  const n = Math.min(typedArr.length, r.textArr.length);
  while (prefix < n && typedArr[prefix] === r.textArr[prefix]) prefix++;

  const elapsed = (Date.now() - r.startTime) / 1000;
  const minutes = Math.max(elapsed / 60, 1 / 60);
  const wpm = Math.min(400, Math.round(prefix / 5 / minutes));
  const accuracy = r.maxLen > 0 ? Math.round(((r.maxLen - r.wrong.size) / r.maxLen) * 100) : 100;
  const progress = (prefix / r.textArr.length) * 100;

  renderQuote(typedArr);
  $('#liveWpm').textContent = wpm;
  $('#liveAcc').textContent = accuracy + '%';
  $('#liveTime').textContent = elapsed.toFixed(1) + 's';
  updateClimber(myLaneId(), progress);
  const myWpm = document.getElementById(`wpm-${myLaneId()}`);
  if (myWpm) myWpm.textContent = wpm + ' WPM';

  const finished = prefix === r.textArr.length && typedArr.length === r.textArr.length;
  if (finished) {
    r.finished = true;
    clearInterval(r.timerInterval);
    typeInput.disabled = true;
    sfx.finish();
    if (state.mode === 'race') {
      $('#finishMsg').classList.remove('hidden');
      sendProgress(true);
    } else if (state.mode === 'practice') {
      updateClimber('me', 100, { finished: true, rank: 1 });
      state.socket.emit('practice_finish', { typed: r.typed, maxLen: r.maxLen, mistakes: r.wrong.size });
    }
  } else {
    sendProgress(false);
  }
});

function finishRaceTimers() {
  clearInterval(state.race.timerInterval);
  clearTimeout(state.race.sendTimer);
  state.race.running = false;
}

function resetRace() {
  const r = state.race;
  clearInterval(r.timerInterval);
  clearTimeout(r.cdTimer);
  clearTimeout(r.sendTimer);
  r.running = false;
  $('#countdown').classList.add('hidden');
}

$('#quitRaceBtn').addEventListener('click', () => {
  if (state.mode === 'race' && state.socket) state.socket.emit('leave_room');
  state.room = null;
  enterLobby();
});

// ========== Results ==========
function showResults(results, kind) {
  state.resultKind = kind;
  resetRace();
  state.mode = 'idle';

  const medals = ['🥇', '🥈', '🥉'];
  const mine = results.find((r) => r.username === state.user.username);
  $('#resultTitle').textContent =
    kind === 'practice' ? 'Practice Complete' : results.some((r) => r.finished) ? 'Race Complete' : "Time's Up!";

  $('#resultList').innerHTML = results.map((r) => {
    if (!r.finished) {
      return `
        <div class="result-row dnf">
          <span class="pos">—</span>
          <span class="name">${escapeHtml(r.username)}</span>
          <span class="stats">Did not finish · ${r.progress || 0}%</span>
        </div>`;
    }
    return `
      <div class="result-row">
        <span class="pos">${kind === 'practice' ? '🏔️' : medals[r.rank - 1] || r.rank + '.'}</span>
        <span class="name">${escapeHtml(r.username)}</span>
        <span class="stats">${r.wpm} WPM · ${r.accuracy}% · ${r.time}s</span>
      </div>`;
  }).join('');

  if (kind === 'race' && mine && mine.finished && mine.rank === 1) sfx.finish();
  updateResultButtons();
  showView('result');
}

function updateResultButtons() {
  const practice = state.resultKind === 'practice';
  const host = amHost();
  $('#rematchBtn').classList.toggle('hidden', practice || !host);
  $('#waitHostMsg').classList.toggle('hidden', practice || host);
  $('#practiceAgainBtn').classList.toggle('hidden', !practice);
}

$('#rematchBtn').addEventListener('click', () => {
  state.socket.emit('rematch');
});

$('#practiceAgainBtn').addEventListener('click', () => {
  if (!state.lastPractice) return enterLobby();
  sfx.tick();
  state.socket.emit('practice_start', state.lastPractice);
});

$('#backToLobbyBtn').addEventListener('click', () => {
  // Actually leave the room on the server, so you never stay as a "ghost" player
  if (state.room && state.socket) state.socket.emit('leave_room');
  state.room = null;
  enterLobby();
});

// ========== Init ==========
if (state.token && state.user) {
  connectSocket();
  enterLobby();
} else {
  showView('auth');
}
