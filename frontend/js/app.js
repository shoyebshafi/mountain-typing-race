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
  standings: {},
  raceOver: false,
  race: newRaceState(),
  colors: ['#38bdf8', '#f97316', '#a78bfa', '#f43f5e', '#eab308', '#14b8a6', '#ec4899', '#84cc16']
};

function newRaceState(text = '') {
  const normalized = normalize(text);
  return {
    text: normalized,
    textArr: Array.from(normalized),
    prep: Scoring.prepare(normalized),
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
    renderedLen: 0,
    timed: false,
    duration: 0,
    goalChars: 0,
    samples: [],
    sampleTimer: null,
    correct: 0,
    consistency: null,
    liveWpm: 0,
    liveAcc: 100
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
// Also removes invisible zero-width characters that some Bangla keyboards add.
function normalize(s) {
  return (s || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
}

// Characters that different keyboards type differently count as the same:
// Bangla digits and ASCII digits, the danda and the full stop, curly and straight quotes.
const BN_DIGITS = '\u09E6\u09E7\u09E8\u09E9\u09EA\u09EB\u09EC\u09ED\u09EE\u09EF';
const ALIASES = { '\u0964': '.', '\u2019': "'", '\u2018': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-' };
function charKey(ch) {
  const d = BN_DIGITS.indexOf(ch);
  if (d >= 0) return String(d);
  return ALIASES[ch] || ch;
}
function sameChar(a, b) {
  return a === b || charKey(a) === charKey(b);
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
  const str = String(s);
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
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
      const gone = Object.values(state.standings).find((x) => x.username === leftUsername);
      if (gone) gone.left = true;
      if (!$('#racePanel').classList.contains('hidden')) renderRacePanel();
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
    state.raceOver = false;
    state.standings = {};
    room.players.forEach((p, idx) => {
      state.standings[p.socketId] = {
        idx, username: p.username, progress: 0, wpm: 0, accuracy: 100,
        finished: false, rank: null, time: null, left: false, dnf: false
      };
    });
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

    const row = state.standings[data.socketId];
    if (row) {
      Object.assign(row, {
        progress: data.progress, wpm: data.wpm, accuracy: data.accuracy,
        finished: data.finished, rank: data.rank, time: data.time
      });
    }
    // the result box opens for each player the moment they finish
    if (mine && data.finished) showRacePanel();
    else if (!$('#racePanel').classList.contains('hidden')) renderRacePanel();
  });

  // places can change whenever someone finishes (the highest WPM is first)
  socket.on('ranks_update', ({ ranks }) => {
    if (state.mode !== 'race') return;
    ranks.forEach((r) => {
      const row = state.standings[r.socketId];
      if (row) row.rank = r.rank;
      updateClimber(r.socketId, undefined, { finished: true, rank: r.rank });
    });
    if (!$('#racePanel').classList.contains('hidden')) renderRacePanel();
  });

  socket.on('race_finished', ({ results, room }) => {
    state.room = room;
    state.raceOver = true;
    finishRaceTimers();
    results.forEach((r) => {
      const entry = Object.values(state.standings).find((x) => x.username === r.username);
      if (!entry) return;
      if (r.finished) {
        Object.assign(entry, { finished: true, rank: r.rank, wpm: r.wpm, accuracy: r.accuracy, time: r.time, progress: 100 });
      } else {
        Object.assign(entry, { dnf: true, wpm: r.wpm, accuracy: r.accuracy, progress: r.progress || entry.progress });
      }
    });
    // anyone still typing when the clock runs out is stopped here
    const rs = state.race;
    if (!rs.finished) {
      rs.finished = true;
      rs.running = false;
      $('#typeInput').disabled = true;
      setOverlay(null);
    }
    showRacePanel();
  });

  socket.on('rematch_ready', ({ room }) => {
    state.room = room;
    state.mode = 'idle';
    resetRace();
    enterRoomView(room);
  });

  // ----- Practice -----
  socket.on('practice_ready', ({ text, mode, duration }) => {
    state.mode = 'practice';
    setupRace(text, [{ socketId: 'me', username: state.user.username }], { timed: mode === 'timed', duration });
    localCountdown(startTyping);
  });

  socket.on('practice_result', (r) => {
    const title = r.mode === 'timed' ? `${r.duration} Second Test Complete` : 'Practice Complete';
    showResults(
      [{ username: state.user.username, wpm: r.wpm, accuracy: r.accuracy, rank: 1, time: r.time, finished: true }],
      'practice',
      title
    );
    $('#resultMistakes').innerHTML = mistakesHtml();
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
        <span class="name"><button type="button" class="user-link" data-user="${escapeHtml(row.username)}">${escapeHtml(row.username)}</button></span>
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
  const useCustom = $('#customToggle').checked;
  const customText = useCustom ? $('#customTextInput').value.trim() : '';
  if (useCustom && customText.length < 20) {
    $('#createError').textContent = 'Custom text needs at least 20 characters.';
    return;
  }
  state.socket.emit('create_room', { customText, isPublic: $('#publicToggle').checked });
});

$('#customToggle').addEventListener('change', (e) => {
  $('#customTextInput').classList.toggle('hidden', !e.target.checked);
  if (e.target.checked) $('#customTextInput').focus();
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

$('#joinRandomBtn').addEventListener('click', () => {
  $('#joinError').textContent = '';
  if (!state.socket || !state.socket.connected) {
    $('#joinError').textContent = 'Not connected. Please refresh.';
    return;
  }
  state.socket.emit('join_random');
});

// Practice: Random Text | Custom Text | 30 second Test | 60 second Test
let practiceMode = 'random';

function applyPracticeMode(mode) {
  practiceMode = mode;
  $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const custom = mode === 'custom';
  $('#practiceCustomText').classList.toggle('hidden', !custom);
  $('#practiceOpts').classList.toggle('hidden', custom);
  $('#practiceWordsWrap').classList.toggle('hidden', mode !== 'random');
  $('#practiceError').textContent = '';
}
$$('.mode-btn').forEach((b) => b.addEventListener('click', () => applyPracticeMode(b.dataset.mode)));

$('#practiceStartBtn').addEventListener('click', () => {
  $('#practiceError').textContent = '';
  if (!state.socket || !state.socket.connected) {
    $('#practiceError').textContent = 'Not connected. Please refresh the page.';
    return;
  }
  const language = $('#practiceLang').value;
  const topic = $('#practiceTopic').value;
  let payload;
  if (practiceMode === 'custom') {
    const customText = $('#practiceCustomText').value.trim();
    if (customText.length < 20) {
      $('#practiceError').textContent = 'Custom text needs at least 20 characters.';
      return;
    }
    payload = { mode: 'custom', customText };
  } else if (practiceMode === 'random') {
    payload = { mode: 'random', language, topic, words: $('#practiceWords').value };
  } else {
    payload = { mode: 'timed', duration: practiceMode === 't60' ? 60 : 30, language, topic };
  }
  state.lastPractice = payload;
  sfx.tick();
  state.socket.emit('practice_start', payload);
});

// ========== Profile ==========
$('#leaderboard').addEventListener('click', (e) => {
  const b = e.target.closest('.user-link');
  if (b) openProfile(b.dataset.user);
});
$('#profileBtn').addEventListener('click', openProfile);
$('#backFromProfileBtn').addEventListener('click', enterLobby);

async function openProfile(target) {
  const viewing = typeof target === 'string' ? target : state.user.username;
  const mine = viewing.toLowerCase() === state.user.username.toLowerCase();
  $('#profileName').textContent = mine ? state.user.username : viewing + "'s profile";
  $('#avTitle').textContent = mine ? 'Your Climber' : viewing + "'s Climber";
  $('#avatarPanel').classList.toggle('readonly', !mine);
  $('#dangerPanel').classList.toggle('hidden', !mine);
  resetDeleteForm();
  $('#profileStats').innerHTML = '<p class="hint">Loading...</p>';
  $('#profileChart').innerHTML = '';
  $('#profileRecent').innerHTML = '';
  initAvatarEditor(mine ? undefined : null);
  showView('profile');
  try {
    const res = await fetch(mine ? '/api/me' : '/api/users/' + encodeURIComponent(viewing), {
      headers: { Authorization: 'Bearer ' + state.token }
    });
    if (mine && (res.status === 401 || res.status === 404)) {
      logout();
      toast('Your account was not found. Please register or log in again.');
      return;
    }
    if (!mine && res.status === 404) {
      toast('Player not found');
      enterLobby();
      return;
    }
    const data = await res.json();
    if (mine) {
      if (data.user && data.user.avatar) {
        state.user.avatar = data.user.avatar;
        localStorage.setItem('mtr_user', JSON.stringify(state.user));
        initAvatarEditor();
      }
    } else {
      initAvatarEditor(data.user.avatar || null);
    }
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
  $('#openBadge').classList.toggle('hidden', !room.isPublic);
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
  state.socket.emit('start_race', {
    language: $('#raceLang').value,
    topic: $('#raceTopic').value,
    words: $('#raceWords').value
  });
});

$('#leaveRoomBtn').addEventListener('click', () => {
  state.socket.emit('leave_room');
  state.room = null;
  enterLobby();
});

// ========== Race ==========
function setupRace(text, players, opts = {}) {
  resetRace();
  state.race = newRaceState(text);
  state.race.timed = !!opts.timed;
  state.race.duration = opts.duration || 0;
  state.race.goalChars = state.race.duration * (500 / 60); // timed test: the summit is a 100 WPM pace
  $('#timeLabel').textContent = state.race.timed ? 'Time left' : 'Time';
  $('#typingArea').classList.remove('hidden');
  $('#racePanel').classList.add('hidden');

  const container = $('#climbersContainer');
  container.innerHTML = '';
  const lanes = $('#lanesLayer');
  lanes.innerHTML = '';
  const count = players.length;
  players.forEach((p, idx) => {
    const id = p.socketId;
    const isMe = state.mode === 'practice' ? true : id === state.socket.id;
    const color = state.colors[idx % state.colors.length];
    const avatar = avatarFor(state.mode === 'practice' ? state.user.avatar : p.avatar, idx);

    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.left = laneX(idx, count) / 10 + '%';
    lane.style.setProperty('--c', color);
    lane.innerHTML = '<span class="lane-rope"></span><span class="lane-anchor"></span><span class="lane-flag"></span>';
    lanes.appendChild(lane);

    const hiker = document.createElement('div');
    hiker.className = 'hiker' + (isMe ? ' me' : '') + (idx % 2 ? ' odd' : '');
    hiker.id = `climber-${id}`;
    hiker.dataset.user = p.username;
    hiker.dataset.slot = String(idx);
    hiker.dataset.count = String(count);
    hiker.dataset.progress = '0';
    hiker._phase = 0.12;
    hiker.innerHTML = `
      <div class="hiker-tag">
        <span class="hiker-name">${escapeHtml(p.username)}${isMe ? ' (you)' : ''}</span>
        <span class="hiker-wpm" id="wpm-${id}">0 WPM</span>
      </div>
      ${Hiker.buildSvg(avatar, Hiker.computePose(0.12, false, 0))}
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
  $('#liveTime').textContent = state.race.timed ? state.race.duration.toFixed(1) + 's' : '0.0s';
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
  r.sampleTimer = setInterval(() => r.samples.push(r.correct), 1000);
}

function tickTime() {
  const r = state.race;
  if (!r.startTime || r.finished) return;
  const elapsed = (Date.now() - r.startTime) / 1000;
  if (r.timed) {
    const left = Math.max(0, r.duration - elapsed);
    $('#liveTime').textContent = left.toFixed(1) + 's';
    if (left <= 0) finishTyping();
  } else {
    $('#liveTime').textContent = elapsed.toFixed(1) + 's';
  }
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

// Colours the text from the scoring result. Three states are always easy to tell apart:
//   gray   = still to type          blue block = the letter to type NOW          green = typed right
//   red    = ONLY the part that is wrong (the whole visible unit, so a wrong vowel sign can not hide)
function updateQuote(ev) {
  const r = state.race;
  const n = r.spans.length;
  if (!n) return;
  const prep = r.prep;
  const nWords = prep.words.length;
  const chars = prep.chars;
  const cls = new Array(n).fill('');
  const cache = r.alignCache || (r.alignCache = {});

  // marks: 'ok' | 'bad' | '' for each character of word w
  const paint = (w, marks) => {
    const start = prep.starts[w];
    const end = start + prep.words[w].length;
    marks.forEach((m, j) => { if (m === 'ok') cls[start + j] = 'correct'; });
    marks.forEach((m, j) => {
      if (m !== 'bad') return;
      const [cs, ce] = Scoring.clusterRange(chars, start + j);
      for (let i = Math.max(cs, start); i < Math.min(ce, end); i++) cls[i] = 'incorrect';
    });
  };

  // words that are completely typed
  for (let w = 0; w < ev.flags.length && w < nWords; w++) {
    const start = prep.starts[w];
    const len = prep.words[w].length;
    if (ev.flags[w]) {
      for (let i = start; i < start + len; i++) cls[i] = 'correct';
    } else {
      const typed = ev.typedWords[w] || [];
      const key = w + ':' + typed.join('');
      const al = cache[key] || (cache[key] = Scoring.align(typed, prep.words[w], false));
      paint(w, al.marks);
    }
    if (start + len < n && chars[start + len] === ' ') cls[start + len] = 'correct';
  }

  // the word being typed right now
  let cursor = ev.finished || ev.done >= nWords ? n : prep.starts[ev.done];
  if (ev.inProgress && !ev.finished && ev.done < nWords) {
    const al = Scoring.align(ev.cur, prep.words[ev.done], true);
    paint(ev.done, al.marks);
    cursor = prep.starts[ev.done] + al.endJ;
  }

  // the letter to type next: a solid block over its whole visible unit
  if (!ev.finished && cursor < n) {
    const end = Scoring.clusterRange(chars, cursor)[1];
    for (let i = cursor; i < Math.min(end, n); i++) if (!cls[i]) cls[i] = 'current';
  }

  for (let i = 0; i < n; i++) {
    if (r.spans[i].className !== cls[i]) r.spans[i].className = cls[i];
  }

  // keep the active line as the second visible line
  const box = $('#quoteDisplay');
  const cur = r.spans[Math.min(cursor, n - 1)];
  const cs = getComputedStyle(box);
  const lh = parseFloat(cs.lineHeight) || 40;
  const pad = parseFloat(cs.paddingTop) || 0;
  const wanted = Math.max(0, cur.offsetTop - pad - lh);
  if (Math.abs(wanted - box.scrollTop) > lh * 0.5) box.scrollTop = wanted;
}

// ----- The mountain: a rock face seen from the front. Every player climbs their own lane. -----
const SUMMIT_METERS = 3000;
// Scene units (the scene is 1000 x 620): feet at the foot of the wall -> feet on the summit ridge
const START_Y = 592;
const TOP_Y = 188;

function laneX(slot, count) {
  const gap = Math.min(118, 820 / Math.max(count, 1));
  return 500 + (slot - (count - 1) / 2) * gap;
}

// pine trees at the foot of the mountain
function buildScene() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let trees = '';
  for (let x = 10; x < 1000; x += 24) {
    const y = 574 + rnd() * 38;
    const h = 26 + rnd() * 22;
    const w = 8 + rnd() * 5;
    trees += `<g><rect x="${x - 1.5}" y="${y}" width="3" height="7" fill="#33241a"/>` +
      `<polygon points="${x},${y - h} ${x - w},${y + 3} ${x + w},${y + 3}" fill="#06291e"/>` +
      `<polygon points="${x},${y - h - 9} ${x - w * 0.7},${y - h + 14} ${x + w * 0.7},${y - h + 14}" fill="#0a3828"/></g>`;
  }
  $('#trees').innerHTML = trees;
}
buildScene();

// Optional: put a real mountain photo at frontend/img/mountain.jpg and the game uses it as the background.
(function loadScenePhoto() {
  const img = new Image();
  img.onload = () => {
    $('#scenePhoto').style.backgroundImage = `url("${img.src}")`;
    $('#mountainTrack').classList.add('has-photo');
  };
  img.src = 'img/mountain.jpg';
})();

// A player without a saved look gets a default one in their own colour.
function avatarFor(av, idx) {
  return Hiker.sanitize(av) || Hiker.defaultFor(state.colors[idx % state.colors.length], idx);
}

function placeHiker(el, progress) {
  const slot = Number(el.dataset.slot || 0);
  const count = Number(el.dataset.count || 1);
  const p = Math.min(Math.max(progress, 0), 100);
  const y = START_Y - ((START_Y - TOP_Y) * p) / 100;
  el.style.left = laneX(slot, count) / 10 + '%';
  el.style.top = y / 6.2 + '%';
  el.style.zIndex = String(Math.round(y));
}

// The climbing gait: while a player is moving up, their hands and feet keep reaching for the next hold.
let gaitRaf = 0;
let gaitLast = 0;
function gaitLoop(ts) {
  const dt = Math.min(0.05, (ts - gaitLast) / 1000);
  gaitLast = ts;
  let active = false;
  document.querySelectorAll('#climbersContainer .hiker').forEach((el) => {
    const svg = el._svg || (el._svg = el.querySelector('.hiker-fig'));
    if (!svg) return;
    if (el.classList.contains('summit')) {
      Hiker.applyPose(svg, Hiker.computePose(0, true, ts / 1000 + Number(el.dataset.slot || 0) * 0.7));
      active = true;
    } else if (el._moveUntil && el._moveUntil > ts) {
      el._phase = (el._phase || 0) + dt * 1.0;
      Hiker.applyPose(svg, Hiker.computePose(el._phase, false, 0));
      active = true;
    }
  });
  gaitRaf = active ? requestAnimationFrame(gaitLoop) : 0;
}
function startGait() {
  if (!gaitRaf) {
    gaitLast = performance.now();
    gaitRaf = requestAnimationFrame(gaitLoop);
  }
}

function updateClimber(id, progress, extra = {}) {
  const el = document.getElementById(`climber-${id}`);
  if (!el) return;

  if (progress !== undefined) {
    const prev = parseFloat(el.dataset.progress || '0');
    placeHiker(el, progress);
    if (progress > prev) {
      el._moveUntil = performance.now() + 550;
      startGait();
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
    el.classList.add('summit');
    if (extra.rank) {
      const badge = document.getElementById(`rank-${id}`);
      if (badge) {
        badge.textContent = '#' + extra.rank;
        badge.classList.remove('hidden');
      }
    }
    startGait();
  }
}

function sendProgress(force = false) {
  if (state.mode !== 'race') return;
  const r = state.race;
  const emit = () => {
    r.sendTimer = null;
    r.lastSent = Date.now();
    state.socket.emit('progress', { typed: r.typed });
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
  if (e.key === 'Enter') {
    e.preventDefault();
    // Enter works like Space, so the last word can always be finished
    const r = state.race;
    if (r.running && !r.finished) {
      typeInput.value += ' ';
      handleTyping();
    }
  }
});

// If the player clicks away mid-race, tell them how to continue
typeInput.addEventListener('focus', () => {
  if (state.race.running && !state.race.finished) setOverlay(null);
});
typeInput.addEventListener('blur', () => {
  if (state.race.running && !state.race.finished) setOverlay('Click here to keep typing');
});

function handleTyping() {
  const r = state.race;
  if (!r.running || r.finished) return;

  const value = normalize(typeInput.value);
  r.typed = value;
  const ev = Scoring.evaluate(r.prep, value, { timed: r.timed });

  if (value.length > r.lastLen) (ev.lastOk ? sfx.key : sfx.error)();
  r.lastLen = value.length;
  r.correct = ev.correctChars;

  // Speed counts only the words that are right. Accuracy = right words / all words.
  const elapsed = (Date.now() - r.startTime) / 1000;
  const minutes = Math.max(elapsed / 60, 1 / 60);
  const wpm = Math.min(400, Math.round(ev.wpmChars / 5 / minutes));
  const accuracy = ev.accuracy;
  const progress = r.timed
    ? Math.min(100, (ev.wpmChars / r.goalChars) * 100)
    : (ev.cursor / r.prep.length) * 100;
  r.liveWpm = wpm;
  r.liveAcc = accuracy;

  updateQuote(ev);
  $('#liveWpm').textContent = wpm;
  $('#liveAcc').textContent = accuracy + '%';
  if (!r.timed) $('#liveTime').textContent = elapsed.toFixed(1) + 's';
  updateClimber(myLaneId(), progress);
  const myWpm = document.getElementById(`wpm-${myLaneId()}`);
  if (myWpm) myWpm.textContent = wpm + ' WPM';

  const onLastWord = !r.timed && ev.inProgress && !ev.finished && ev.done === r.prep.words.length - 1;
  $('#typeHint').classList.toggle('hidden', !onLastWord);

  if (ev.finished) finishTyping();
  else sendProgress(false);
}

// 'input' fires on every change; 'compositionend' makes sure the last Bangla character
// typed through an input method is never missed.
typeInput.addEventListener('input', handleTyping);
typeInput.addEventListener('compositionend', handleTyping);

// How steady the typing pace was (100% = perfectly even)
function calcConsistency(samples) {
  const perSecond = [];
  for (let i = 1; i < samples.length; i++) perSecond.push(samples[i] - samples[i - 1]);
  const vals = perSecond.slice(1); // ignore the warm-up second
  if (vals.length < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return 0;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return Math.max(0, Math.min(100, Math.round(100 - (Math.sqrt(variance) / mean) * 100)));
}

function finishTyping() {
  const r = state.race;
  if (r.finished) return;
  r.finished = true;
  clearInterval(r.timerInterval);
  clearInterval(r.sampleTimer);
  typeInput.disabled = true;
  setOverlay(null);
  $('#typeHint').classList.add('hidden');
  sfx.finish();
  r.consistency = calcConsistency(r.samples);
  const elapsed = (Date.now() - r.startTime) / 1000;

  if (state.mode === 'race') {
    // Open our own result box right away; rank and exact time are confirmed by the server a moment later.
    const me = state.standings[state.socket.id];
    if (me) Object.assign(me, { finished: true, progress: 100, wpm: r.liveWpm, accuracy: r.liveAcc, time: elapsed.toFixed(1) });
    sendProgress(true);
    showRacePanel();
  } else if (state.mode === 'practice') {
    if (!r.timed) updateClimber('me', 100, { finished: true, rank: 1 });
    state.socket.emit('practice_finish', { typed: r.typed });
  }
}

function finishRaceTimers() {
  clearInterval(state.race.timerInterval);
  clearInterval(state.race.sampleTimer);
  clearTimeout(state.race.sendTimer);
  state.race.running = false;
}

function resetRace() {
  const r = state.race;
  clearInterval(r.timerInterval);
  clearInterval(r.sampleTimer);
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

// ========== Room race result box ==========
// Opens for each player as soon as they finish. They keep watching the mountain,
// see the live standings, and can leave whenever they like.
const ordinal = (n) => {
  const suffix = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
};

function showRacePanel() {
  const panel = $('#racePanel');
  const firstTime = panel.classList.contains('hidden');
  $('#typingArea').classList.add('hidden');
  panel.classList.remove('hidden');
  renderRacePanel();
  if (firstTime) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// "Words to practice": what the text said and what was typed, plus the hidden character codes.
function mistakesHtml() {
  const r = state.race;
  if (!r.prep || !r.typed) return '';
  const list = Scoring.wrongWords(r.prep, r.typed);
  if (!list.length) return '<p class="mistakes-ok">🎯 No wrong words. Perfect!</p>';
  const code = (str) => Array.from(str).map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
  const shown = list.slice(0, 12);
  return `
    <h4 class="rp-sub">Words to practice <span class="muted">(${list.length} wrong)</span></h4>
    <div class="mistakes">
      ${shown.map((w) => `<div class="mistake"><span class="m-exp">${escapeHtml(w.expected)}</span><span class="m-arrow">→</span><span class="m-typed">${w.typed ? escapeHtml(w.typed) : '(skipped)'}</span></div>`).join('')}
    </div>
    <details class="m-codes"><summary>Show character codes</summary>
      ${shown.map((w) => `<div><b>${escapeHtml(w.expected)}</b> ${code(w.expected)}<br/><b>${escapeHtml(w.typed)}</b> ${code(w.typed)}</div>`).join('')}
    </details>`;
}

function renderRacePanel() {
  const mySid = state.socket && state.socket.id;
  const medals = ['🥇', '🥈', '🥉'];
  const rows = Object.entries(state.standings).map(([sid, s]) => ({ sid, ...s }));
  const total = rows.length;
  const me = state.standings[mySid];

  if (me && me.finished) {
    $('#rpEyebrow').textContent = state.raceOver ? 'Final result' : 'You finished';
    $('#rpTitle').textContent = me.rank
      ? `${medals[me.rank - 1] || '🏁'} ${state.raceOver ? '' : 'Now '}${ordinal(me.rank)} place${total > 1 ? ' of ' + total : ''}`
      : '🏁 Finished!';
  } else {
    $('#rpEyebrow').textContent = 'Race over';
    $('#rpTitle').textContent = "⏱️ Time's up";
  }
  $('#rpWpm').textContent = me ? me.wpm : 0;
  $('#rpAcc').textContent = (me ? me.accuracy : 0) + '%';
  $('#rpCons').textContent = state.race.consistency == null ? '—' : state.race.consistency + '%';
  $('#rpTime').textContent = me && me.time ? me.time + 's' : '—';

  const badge = $('#rpState');
  badge.textContent = state.raceOver ? 'Race complete' : 'Others are still racing. Places go by WPM, so they can still change.';
  badge.classList.toggle('over', state.raceOver);

  const order = (r) => (r.finished ? r.rank || 500 : r.left || r.dnf ? 3000 - r.progress : 1000 - r.progress);
  rows.sort((a, b) => order(a) - order(b));

  $('#rpStandings').innerHTML = rows.map((r) => {
    const out = !r.finished && (r.left || r.dnf);
    let status;
    if (r.finished) status = `${r.time}s · ${r.accuracy}%`;
    else if (r.left) status = 'Left the room';
    else if (r.dnf) status = 'Did not finish';
    else status = `Typing… ${Math.round(r.progress)}%`;
    const pos = r.finished ? (r.rank ? medals[r.rank - 1] || '#' + r.rank : '…') : out ? '—' : '⌨️';
    return `
      <div class="st-row ${r.sid === mySid ? 'me' : ''} ${r.finished ? 'done' : ''} ${out ? 'out' : ''}">
        <span class="st-pos">${pos}</span>
        <span class="avatar sm" style="background:${state.colors[r.idx % state.colors.length]}">${escapeHtml(r.username.charAt(0).toUpperCase())}</span>
        <span class="st-name">${escapeHtml(r.username)}${r.sid === mySid ? ' (you)' : ''}</span>
        <span class="st-bar"><span style="width:${Math.round(r.progress)}%"></span></span>
        <span class="st-wpm">${r.wpm} WPM</span>
        <span class="st-status">${status}</span>
      </div>`;
  }).join('');

  const host = amHost();
  $('#rpRematchBtn').classList.toggle('hidden', !(state.raceOver && host));
  $('#rpWait').classList.toggle('hidden', !(state.raceOver && !host));
  $('#rpMistakes').innerHTML = mistakesHtml();
}

$('#rpRematchBtn').addEventListener('click', () => state.socket.emit('rematch'));
$('#rpLeaveBtn').addEventListener('click', () => {
  if (state.socket) state.socket.emit('leave_room');
  state.room = null;
  enterLobby();
});

// ========== Results ==========
function showResults(results, kind, titleOverride) {
  state.resultKind = kind;
  resetRace();
  state.mode = 'idle';

  const medals = ['🥇', '🥈', '🥉'];
  const mine = results.find((r) => r.username === state.user.username);
  $('#resultTitle').textContent =
    titleOverride || (kind === 'practice' ? 'Practice Complete' : results.some((r) => r.finished) ? 'Race Complete' : "Time's Up!");

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

// ========== Climber (avatar) editor ==========
const AV_GROUPS = [
  { title: 'Body', rows: [
    { key: 'skin', label: 'Skin tone', kind: 'color', colors: Hiker.SKIN_TONES },
    { key: 'hair', label: 'Hair', kind: 'choice', options: [['short', 'Short'], ['long', 'Long'], ['bun', 'Bun'], ['buzz', 'Buzz cut'], ['bald', 'Bald']] },
    { key: 'hairColor', label: 'Hair color', kind: 'color', colors: Hiker.HAIR_COLORS }
  ] },
  { title: 'Clothes', rows: [
    { key: 'outfit', label: 'Top', kind: 'choice', options: [['jacket', 'Jacket'], ['hoodie', 'Hoodie'], ['tshirt', 'T-shirt'], ['sleeveless', 'Sleeveless']] },
    { key: 'top', label: 'Top color', kind: 'color', colors: Hiker.PALETTE },
    { key: 'legs', label: 'Bottoms', kind: 'choice', options: [['long', 'Long pants'], ['shorts', 'Shorts']] },
    { key: 'pants', label: 'Bottom color', kind: 'color', colors: Hiker.PALETTE },
    { key: 'shoes', label: 'Shoe color', kind: 'color', colors: Hiker.PALETTE }
  ] },
  { title: 'Gear', rows: [
    { key: 'hat', label: 'Headwear', kind: 'choice', options: [['none', 'None'], ['beanie', 'Beanie'], ['cap', 'Cap'], ['helmet', 'Helmet']] },
    { key: 'hatColor', label: 'Headwear color', kind: 'color', colors: Hiker.PALETTE },
    { key: 'pack', label: 'Backpack', kind: 'choice', options: [['none', 'None'], ['small', 'Small'], ['large', 'Large']] },
    { key: 'packColor', label: 'Backpack color', kind: 'color', colors: Hiker.PALETTE }
  ] }
];

let avDraft = null;
let avRaf = 0;
let avPhase = 0.12;

function initAvatarEditor(avatarOverride) {
  const source = avatarOverride !== undefined ? avatarOverride : state.user && state.user.avatar;
  avDraft = Object.assign({}, Hiker.sanitize(source) || Hiker.DEFAULT_AVATAR);
  $('#avControls').innerHTML = AV_GROUPS.map((g) => `
    <div class="av-group">
      <h4>${g.title}</h4>
      ${g.rows.map((r) => `
        <div class="av-row">
          <span class="av-label">${r.label}</span>
          <div class="av-opts">
            ${r.kind === 'choice'
              ? r.options.map(([v, t]) => `<button type="button" class="opt-btn" data-key="${r.key}" data-val="${v}">${t}</button>`).join('')
              : r.colors.map((c) => `<button type="button" class="sw" data-key="${r.key}" data-val="${c}" style="background:${c}" aria-label="${c}"></button>`).join('') +
                `<input type="color" class="color-pick" data-key="${r.key}" aria-label="Custom color" />`}
          </div>
        </div>`).join('')}
    </div>`).join('');
  $('#avMsg').textContent = '';
  syncAvatarEditor();
  startAvatarPreview();
}

function syncAvatarEditor() {
  $$('#avControls .opt-btn').forEach((b) => b.classList.toggle('active', avDraft[b.dataset.key] === b.dataset.val));
  $$('#avControls .sw').forEach((b) => b.classList.toggle('active', avDraft[b.dataset.key] === b.dataset.val));
  $$('#avControls .color-pick').forEach((i) => { i.value = avDraft[i.dataset.key]; });
  renderAvatarPreview();
}

function renderAvatarPreview() {
  const cheer = $('#avCheer').checked;
  $('#avPreview').innerHTML = Hiker.buildSvg(avDraft, Hiker.computePose(avPhase, cheer, 0));
}

// the preview keeps climbing so you can see how the clothes move
function startAvatarPreview() {
  cancelAnimationFrame(avRaf);
  let last = performance.now();
  const loop = (ts) => {
    if (!isVisible('profile')) { avRaf = 0; return; }
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    const svg = $('#avPreview').firstElementChild;
    if (svg) {
      const cheer = $('#avCheer').checked;
      if (!cheer) avPhase += dt * 0.8;
      Hiker.applyPose(svg, Hiker.computePose(avPhase, cheer, ts / 1000));
    }
    avRaf = requestAnimationFrame(loop);
  };
  avRaf = requestAnimationFrame(loop);
}

$('#avControls').addEventListener('click', (e) => {
  const b = e.target.closest('.opt-btn, .sw');
  if (!b || !avDraft) return;
  avDraft[b.dataset.key] = b.dataset.val;
  syncAvatarEditor();
});
$('#avControls').addEventListener('input', (e) => {
  if (!e.target.classList.contains('color-pick') || !avDraft) return;
  avDraft[e.target.dataset.key] = e.target.value.toLowerCase();
  $$('#avControls .sw').forEach((b) => b.classList.toggle('active', avDraft[b.dataset.key] === b.dataset.val));
  $$('#avControls .opt-btn').forEach((b) => b.classList.toggle('active', avDraft[b.dataset.key] === b.dataset.val));
  renderAvatarPreview();
});
$('#avCheer').addEventListener('change', renderAvatarPreview);
$('#avResetBtn').addEventListener('click', () => {
  avDraft = Object.assign({}, Hiker.DEFAULT_AVATAR);
  $('#avMsg').textContent = '';
  syncAvatarEditor();
});
$('#avSaveBtn').addEventListener('click', async () => {
  const msg = $('#avMsg');
  msg.textContent = 'Saving...';
  try {
    const res = await fetch('/api/avatar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ avatar: avDraft })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save');
    state.user.avatar = data.avatar;
    localStorage.setItem('mtr_user', JSON.stringify(state.user));
    if (state.socket) state.socket.emit('avatar_updated');
    msg.textContent = 'Saved ✓ Your climber is ready for the mountain.';
  } catch (err) {
    msg.textContent = '';
    toast(err.message);
  }
});

// ========== Delete my account ==========
function resetDeleteForm() {
  $('#delForm').classList.add('hidden');
  $('#delStartBtn').classList.remove('hidden');
  $('#delPass').value = '';
  $('#delMsg').textContent = '';
}
$('#delStartBtn').addEventListener('click', () => {
  $('#delForm').classList.remove('hidden');
  $('#delStartBtn').classList.add('hidden');
  $('#delPass').focus();
});
$('#delCancelBtn').addEventListener('click', resetDeleteForm);
$('#delConfirmBtn').addEventListener('click', async () => {
  const msg = $('#delMsg');
  msg.textContent = '';
  if (!$('#delPass').value) {
    msg.textContent = 'Enter your password to confirm.';
    return;
  }
  try {
    const res = await fetch('/api/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ password: $('#delPass').value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete the account');
    logout();
    toast('Your account was deleted.');
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ========== Init ==========
// If the server does not know this account any more (for example the database was reset), log out cleanly.
async function refreshMe() {
  try {
    const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + state.token } });
    if (res.status === 401 || res.status === 404) {
      logout();
      toast('Your account was not found. Please register or log in again.');
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    state.user = { id: data.user.id, username: data.user.username, avatar: data.user.avatar || null };
    localStorage.setItem('mtr_user', JSON.stringify(state.user));
  } catch { /* offline or server waking up: keep the session */ }
}

if (state.token && state.user) {
  connectSocket();
  enterLobby();
  refreshMe();
} else {
  showView('auth');
}
