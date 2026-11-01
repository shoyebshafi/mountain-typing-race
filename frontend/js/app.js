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
    wrong: new Set(),
    spans: [],
    renderedLen: 0
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
      const leftPlayer = document.querySelector(`.hiker[data-user="${CSS.escape(leftUsername || '')}"]`);
      if (leftPlayer) leftPlayer.classList.add('gone');
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
  $('#welcomeName').textContent = state.user.username;
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
    const medals = ['🥇', '🥈', '🥉'];
    el.innerHTML = data.map((row, i) => `
      <div class="lb-row ${i < 3 ? 'top' + (i + 1) : ''} ${row.username === state.user?.username ? 'me' : ''}">
        <span class="rank">${medals[i] || '#' + (i + 1)}</span>
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
    customText: $('#customTextInput').value.trim()
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
  $('#playersUl').innerHTML = room.players.map((p, i) => `
    <li>
      <span class="pl">
        <span class="avatar" style="background:${state.colors[i % state.colors.length]}">${escapeHtml(p.username.charAt(0).toUpperCase())}</span>
        ${escapeHtml(p.username)}
      </span>
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
    const hiker = document.createElement('div');
    hiker.className = 'hiker' + (isMe ? ' me' : '');
    hiker.id = `climber-${id}`;
    hiker.dataset.user = p.username;
    hiker.dataset.slot = String(idx);
    hiker.dataset.progress = '0';
    hiker.style.setProperty('--c', state.colors[idx % state.colors.length]);
    hiker.innerHTML = `
      <div class="hiker-tag">
        <span class="hiker-name">${escapeHtml(p.username)}${isMe ? ' (you)' : ''}</span>
        <span class="hiker-wpm" id="wpm-${id}">0 WPM</span>
      </div>
      ${hikerSvg()}
      <span class="hiker-rank hidden" id="rank-${id}"></span>
    `;
    container.appendChild(hiker);
    placeHiker(hiker, 0);
  });

  buildQuote();
  const input = $('#typeInput');
  input.value = '';
  input.disabled = true;
  setOverlay('Get ready...');
  $('#liveWpm').textContent = '0';
  $('#liveAcc').textContent = '100%';
  $('#liveTime').textContent = '0.0s';
  $('#liveAlt').textContent = '0 m';
  $('#finishMsg').classList.add('hidden');
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
  setOverlay(null);
  input.focus();
  if (document.activeElement !== input) setOverlay('Click here to start typing');
  r.timerInterval = setInterval(tickTime, 100);
}

function tickTime() {
  const r = state.race;
  if (!r.startTime || r.finished) return;
  $('#liveTime').textContent = ((Date.now() - r.startTime) / 1000).toFixed(1) + 's';
}

// ----- Single-box typing: the quote itself is the typing surface -----
function setOverlay(msg) {
  const o = $('#quoteOverlay');
  if (!msg) {
    o.classList.add('hidden');
    return;
  }
  o.textContent = msg;
  o.classList.remove('hidden');
}

function buildQuote() {
  const r = state.race;
  const box = $('#quoteDisplay');
  const frag = document.createDocumentFragment();
  r.spans = r.textArr.map((ch) => {
    const s = document.createElement('span');
    s.textContent = ch;
    frag.appendChild(s);
    return s;
  });
  box.innerHTML = '';
  box.appendChild(frag);
  box.scrollTop = 0;
  r.renderedLen = 0;
  if (r.spans[0]) r.spans[0].className = 'current';
}

// Only the characters that changed are touched, so long passages stay fast.
function updateQuote(typedArr) {
  const r = state.race;
  const n = r.spans.length;
  if (!n) return;
  const newLen = typedArr.length;
  const from = Math.max(0, Math.min(r.renderedLen, newLen) - 1);
  const to = Math.min(n - 1, Math.max(r.renderedLen, newLen));
  for (let i = from; i <= to; i++) {
    const cls = i < newLen ? (typedArr[i] === r.textArr[i] ? 'correct' : 'incorrect') : i === newLen ? 'current' : '';
    if (r.spans[i].className !== cls) r.spans[i].className = cls;
  }
  r.renderedLen = newLen;

  // keep the active line as the second visible line
  const box = $('#quoteDisplay');
  const cur = r.spans[Math.min(newLen, n - 1)];
  const cs = getComputedStyle(box);
  const lh = parseFloat(cs.lineHeight) || 40;
  const pad = parseFloat(cs.paddingTop) || 0;
  const wanted = Math.max(0, cur.offsetTop - pad - lh);
  if (Math.abs(wanted - box.scrollTop) > lh * 0.5) box.scrollTop = wanted;
}

// ----- The mountain: a switchback trail from base camp to the summit -----
const SUMMIT_METERS = 3000;
// Waypoints in scene units (the scene is 1000 x 600)
const TRAIL = [[200, 570], [700, 540], [300, 485], [690, 430], [340, 375], [650, 325], [390, 275], [610, 228], [450, 180], [535, 140], [500, 84]];
const TRAIL_SEG = [];
let trailTotal = 0;
for (let i = 1; i < TRAIL.length; i++) {
  const [x0, y0] = TRAIL[i - 1];
  const [x1, y1] = TRAIL[i];
  const len = Math.hypot(x1 - x0, y1 - y0);
  TRAIL_SEG.push({ x0, y0, x1, y1, start: trailTotal, len });
  trailTotal += len;
}

// progress 0..100  ->  a point on the trail
function trailPoint(progress) {
  const d = (Math.min(Math.max(progress, 0), 100) / 100) * trailTotal;
  const seg = TRAIL_SEG.find((s) => d <= s.start + s.len) || TRAIL_SEG[TRAIL_SEG.length - 1];
  const t = seg.len ? (d - seg.start) / seg.len : 0;
  return { x: seg.x0 + (seg.x1 - seg.x0) * t, y: seg.y0 + (seg.y1 - seg.y0) * t, dx: seg.x1 - seg.x0 };
}

function buildScene() {
  const d = TRAIL.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
  $('#trailPath').setAttribute('d', d);
  $('#trailShadow').setAttribute('d', d);

  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  let stars = '';
  for (let i = 0; i < 70; i++) {
    stars += `<circle cx="${Math.round(rnd() * 1000)}" cy="${Math.round(rnd() * 240)}" r="${(0.5 + rnd() * 1.2).toFixed(1)}" fill="#fff" opacity="${(0.35 + rnd() * 0.55).toFixed(2)}"${i % 4 === 0 ? ' class="twinkle"' : ''}/>`;
  }
  $('#stars').innerHTML = stars;

  let trees = '';
  for (let x = 14; x < 1000; x += 34) {
    const y = 556 + rnd() * 34;
    const h = 22 + rnd() * 14;
    trees += `<g><rect x="${x - 1.5}" y="${y}" width="3" height="6" fill="#3b2a1a"/>` +
      `<polygon points="${x},${y - h} ${x - 10},${y + 2} ${x + 10},${y + 2}" fill="#0b4a37"/>` +
      `<polygon points="${x},${y - h - 8} ${x - 7},${y - h + 12} ${x + 7},${y - h + 12}" fill="#0f5c44"/></g>`;
  }
  $('#trees').innerHTML = trees;
}
buildScene();

function hikerSvg() {
  return `<svg class="hiker-fig" viewBox="-16 -50 32 54" aria-hidden="true">
    <ellipse cx="0" cy="1" rx="10" ry="2.6" fill="rgba(0,0,0,.35)"/>
    <g class="hiker-body">
      <g class="leg leg-l"><rect x="-5.5" y="-17" width="4.5" height="17" rx="2.2" fill="#1e293b"/></g>
      <g class="leg leg-r"><rect x="1" y="-17" width="4.5" height="17" rx="2.2" fill="#0f172a"/></g>
      <rect class="pack" x="-13" y="-31" width="8" height="15" rx="3"/>
      <rect class="jacket" x="-8" y="-31" width="16" height="16" rx="5"/>
      <line class="arm arm-down" x1="6" y1="-28" x2="9" y2="-17"/>
      <line class="arm arm-up" x1="-6" y1="-28" x2="-12" y2="-42"/>
      <line class="arm arm-up" x1="6" y1="-28" x2="12" y2="-42"/>
      <line class="pole" x1="9" y1="-19" x2="15" y2="1"/>
      <circle cx="0" cy="-36" r="5.5" fill="#fcd5b0"/>
      <path class="hat" d="M-6 -37 a6 6 0 0 1 12 0 z"/>
    </g>
  </svg>`;
}

function placeHiker(el, progress) {
  const pt = trailPoint(progress);
  const slot = Number(el.dataset.slot || 0);
  // spread players side by side so nobody hides behind someone else
  const x = pt.x + ((slot % 4) - 1.5) * 12;
  const y = pt.y + (slot % 2) * 5;
  el.style.left = x / 10 + '%';
  el.style.top = y / 6 + '%';
  // the higher up the mountain, the smaller the hiker looks
  el.style.setProperty('--s', (1 - 0.38 * (progress / 100)).toFixed(3));
  el.style.zIndex = String(Math.round(y));
  el.classList.toggle('face-left', pt.dx < 0);
}

function updateClimber(id, progress, extra = {}) {
  const el = document.getElementById(`climber-${id}`);
  if (!el) return;

  if (progress !== undefined) {
    const prev = parseFloat(el.dataset.progress || '0');
    placeHiker(el, progress);
    if (progress > prev) {
      el.classList.add('walking');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('walking'), 600);
    }
    el.dataset.progress = String(progress);
    if (id === myLaneId()) {
      $('#liveAlt').textContent = Math.round((progress / 100) * SUMMIT_METERS).toLocaleString() + ' m';
    }
  }

  if (extra.wpm !== undefined && id !== myLaneId()) {
    const w = document.getElementById(`wpm-${id}`);
    if (w) w.textContent = extra.wpm + ' WPM';
  }
  if (extra.finished) {
    el.classList.remove('walking');
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

// If the player clicks away mid-race, tell them how to continue
typeInput.addEventListener('focus', () => {
  if (state.race.running && !state.race.finished) setOverlay(null);
});
typeInput.addEventListener('blur', () => {
  if (state.race.running && !state.race.finished) setOverlay('Click here to keep typing');
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

  updateQuote(typedArr);
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
    setOverlay(null);
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
