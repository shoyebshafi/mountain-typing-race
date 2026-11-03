require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const {
  registerUser,
  loginUser,
  saveScore,
  getLeaderboard,
  getUserStats,
  findUserById
} = require('./db');
const { buildText, detectLanguage } = require('./texts');

// The signing secret must survive restarts, otherwise every user would be logged out.
// Priority: JWT_SECRET env var -> backend/.jwt_secret file (created once, never committed).
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(__dirname, '.jwt_secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch { /* first run */ }
  const created = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(file, created, { mode: 0o600 });
  } catch (e) {
    console.warn('[warn] Could not save .jwt_secret. Set the JWT_SECRET environment variable so logins survive restarts.');
  }
  return created;
}
const JWT_SECRET = loadJwtSecret();
// "Always logged in": the token lasts ~10 years. Only the Logout button ends a session.
const TOKEN_LIFETIME = '3650d';
const PORT = process.env.PORT || 3000;
const COUNTDOWN_SECONDS = 3;
const MAX_PLAYERS = 8;          // fixed: the host just starts when ready (even with 2 or 3 players)
const MAX_TEXT_LENGTH = 1500;

const app = express();
const server = http.createServer(app);
const corsOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : null;
const io = new Server(server, corsOrigins ? { cors: { origin: corsOrigins } } : {});

if (corsOrigins) app.use(cors({ origin: corsOrigins }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ========== Text helpers ==========
// Bangla vowel signs can be typed in different code point orders depending on the keyboard.
// Normalizing both sides to NFC makes the comparison fair.
// Also drops invisible zero-width characters that some Bangla keyboards insert.
const norm = (s) => String(s || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
// Race texts are always one line with single spaces (a line break can never be typed).
const cleanText = (s) => norm(s).replace(/\s+/g, ' ').trim();
const toChars = (s) => Array.from(norm(s));

// Characters that different keyboards type differently count as the same:
// Bangla digits and ASCII digits, the danda and the full stop, curly and straight quotes.
const BN_DIGITS = '\u09E6\u09E7\u09E8\u09E9\u09EA\u09EB\u09EC\u09ED\u09EE\u09EF';
const ALIASES = { '\u0964': '.', '\u2019': "'", '\u2018': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-' };
function charKey(ch) {
  const d = BN_DIGITS.indexOf(ch);
  if (d >= 0) return String(d);
  return ALIASES[ch] || ch;
}
const sameChar = (a, b) => a === b || charKey(a) === charKey(b);

function correctPrefix(typedArr, textArr) {
  const n = Math.min(typedArr.length, textArr.length);
  let i = 0;
  while (i < n && sameChar(typedArr[i], textArr[i])) i++;
  return i;
}

// All stats are computed on the server from the typed text, so clients cannot fake them.
function calcStats(textArr, typed, maxLen, mistakes, startedAt, now) {
  const typedArr = toChars(typed);
  const prefix = correctPrefix(typedArr, textArr);
  const finished = prefix === textArr.length;
  const minutes = Math.max((now - startedAt) / 60000, 1 / 60);
  const wpm = Math.min(400, Math.round(prefix / 5 / minutes));
  const mx = Math.max(Number(maxLen) || 0, typedArr.length);
  const m = Math.min(Math.max(Number(mistakes) || 0, 0), mx);
  const accuracy = mx > 0 ? Math.round(((mx - m) / mx) * 100) : 100;
  return {
    prefix,
    finished,
    wpm,
    accuracy,
    progress: (prefix / textArr.length) * 100
  };
}

// Timed tests: every correct character in the right position counts, mistakes do not stop you.
function calcTimedStats(textArr, typed, maxLen, mistakes, durationSec) {
  const typedArr = toChars(typed);
  const n = Math.min(typedArr.length, textArr.length);
  let correct = 0;
  for (let i = 0; i < n; i++) if (sameChar(typedArr[i], textArr[i])) correct++;
  const wpm = Math.min(400, Math.round(correct / 5 / (durationSec / 60)));
  const mx = Math.max(Number(maxLen) || 0, typedArr.length);
  const m = Math.min(Math.max(Number(mistakes) || 0, 0), mx);
  const accuracy = mx > 0 ? Math.round(((mx - m) / mx) * 100) : 100;
  return { wpm, accuracy };
}

// ========== In-memory rooms ==========
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function newPlayer(user) {
  return {
    id: user.id,
    username: user.username,
    progress: 0,
    wpm: 0,
    accuracy: 100,
    finished: false,
    finishTime: null,
    rank: null
  };
}

function resetPlayers(room) {
  Object.values(room.players).forEach((p) =>
    Object.assign(p, { progress: 0, wpm: 0, accuracy: 100, finished: false, finishTime: null, rank: null })
  );
}

function clearTimers(room) {
  clearInterval(room.countdownTimer);
  clearTimeout(room.raceTimer);
  room.countdownTimer = null;
  room.raceTimer = null;
}

// ========== Auth Middleware ==========
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ========== REST API ==========
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await registerUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_LIFETIME });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await loginUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_LIFETIME });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user, stats: getUserStats(req.user.id) });
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const lang = req.query.lang === 'bn' ? 'bn' : 'en';
  res.json(getLeaderboard(lang, limit));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ========== Socket.IO ==========
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.username} (${socket.id})`);

  // ---------- Rooms ----------
  socket.on('create_room', ({ customText } = {}) => {
    if (socket.roomCode) leaveRoom(socket);

    const code = generateRoomCode();
    const cleaned = cleanText(customText);
    const text = cleaned.length >= 20 ? cleaned.slice(0, MAX_TEXT_LENGTH) : null;

    rooms[code] = {
      code,
      hostId: socket.id,
      hostUsername: socket.user.username,
      players: {},
      status: 'waiting',
      text,
      customText: !!text,
      lastText: null,
      textArr: null,
      maxPlayers: MAX_PLAYERS,
      startedAt: null,
      timeLimit: 0,
      language: text ? detectLanguage(text) : 'en',
      results: [],
      countdownTimer: null,
      raceTimer: null
    };

    rooms[code].players[socket.id] = newPlayer(socket.user);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room_created', { code, room: publicRoom(rooms[code]) });
    console.log(`Room created: ${code} by ${socket.user.username}`);
  });

  socket.on('join_room', ({ code } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', { message: 'Room not found' });
    if (room.status !== 'waiting') return socket.emit('error_msg', { message: 'This room is currently racing. Try again soon.' });
    if (Object.keys(room.players).length >= room.maxPlayers) {
      return socket.emit('error_msg', { message: 'Room is full' });
    }
    if (Object.values(room.players).some((p) => p.username === socket.user.username)) {
      return socket.emit('error_msg', { message: 'You are already in this room' });
    }

    if (socket.roomCode) leaveRoom(socket);

    room.players[socket.id] = newPlayer(socket.user);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    io.to(roomCode).emit('player_joined', { room: publicRoom(room) });
    socket.emit('joined_room', { room: publicRoom(room) });
  });

  socket.on('set_text', ({ text } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;

    const cleaned = cleanText(text);
    if (cleaned.length >= 20) {
      room.text = cleaned.slice(0, MAX_TEXT_LENGTH);
      room.customText = true;
      room.language = detectLanguage(room.text);
    } else {
      room.text = null;
      room.customText = false;
    }
    io.to(socket.roomCode).emit('room_updated', { room: publicRoom(room) });
  });

  socket.on('start_race', ({ language = 'en', topic = 'mix', words } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;

    if (room.text) {
      room.language = detectLanguage(room.text);
    } else {
      room.language = language === 'bn' ? 'bn' : 'en';
      room.text = cleanText(buildText(room.language, topic, words));
    }
    room.textArr = toChars(room.text);
    room.timeLimit = Math.min(900, Math.max(60, Math.ceil(room.textArr.length / 1.5)));
    room.results = [];
    resetPlayers(room);
    room.status = 'countdown';

    io.to(room.code).emit('race_starting', { text: room.text, room: publicRoom(room) });
    runCountdown(room);
  });

  socket.on('progress', ({ typed, maxLen, mistakes } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'racing') return;
    const player = room.players[socket.id];
    if (!player || player.finished) return;
    if (typeof typed !== 'string' || typed.length > room.text.length * 2 + 10) return;

    const now = Date.now();
    const s = calcStats(room.textArr, typed, maxLen, mistakes, room.startedAt, now);
    player.progress = s.progress;
    player.wpm = s.wpm;
    player.accuracy = s.accuracy;

    if (s.finished) {
      player.finished = true;
      player.finishTime = now;
      player.progress = 100;
      player.rank = room.results.length + 1;
      const timeSec = (now - room.startedAt) / 1000;
      room.results.push({
        username: player.username,
        wpm: player.wpm,
        accuracy: player.accuracy,
        rank: player.rank,
        time: timeSec.toFixed(1),
        finished: true
      });
      try {
        saveScore(
          player.id, player.wpm, player.accuracy, timeSec, player.rank,
          room.code, room.language, room.customText ? 'custom' : 'race'
        );
      } catch (e) {
        console.error('Score save error:', e.message);
      }
    }

    io.to(room.code).emit('progress_update', {
      socketId: socket.id,
      username: player.username,
      progress: player.progress,
      wpm: player.wpm,
      accuracy: player.accuracy,
      finished: player.finished,
      rank: player.rank,
      time: player.finished ? ((player.finishTime - room.startedAt) / 1000).toFixed(1) : null
    });

    if (Object.values(room.players).every((p) => p.finished)) endRace(room);
  });

  // Host sends everybody back to the waiting room for another round
  socket.on('rematch', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.status !== 'finished') return;
    clearTimers(room);
    room.lastText = room.text;
    if (!room.customText) room.text = null;
    room.results = [];
    resetPlayers(room);
    room.status = 'waiting';
    io.to(room.code).emit('rematch_ready', { room: publicRoom(room) });
  });

  socket.on('leave_room', () => leaveRoom(socket));

  // ---------- Practice (solo): random text, custom text, 30s / 60s tests ----------
  socket.on('practice_start', ({ mode = 'random', duration, language = 'en', topic = 'mix', words, customText } = {}) => {
    const lang = language === 'bn' ? 'bn' : 'en';
    let text, saveMode, secs = 0, textLang = lang;

    if (mode === 'custom') {
      const cleaned = cleanText(customText);
      if (cleaned.length < 20) {
        return socket.emit('error_msg', { message: 'Custom text needs at least 20 characters' });
      }
      text = cleaned.slice(0, MAX_TEXT_LENGTH);
      textLang = detectLanguage(text);
      saveMode = 'custom';
    } else if (mode === 'timed') {
      secs = Number(duration) === 60 ? 60 : 30;
      // plenty of text so nobody can run out before the clock does
      text = cleanText(buildText(lang, topic, secs === 60 ? 260 : 140));
      saveMode = 'timed';
    } else {
      text = cleanText(buildText(lang, topic, words));
      saveMode = 'practice';
    }

    socket.practice = {
      text,
      textArr: toChars(text),
      language: textLang,
      mode: saveMode,
      duration: secs,
      startedAt: Date.now() + COUNTDOWN_SECONDS * 1000,
      done: false
    };
    socket.emit('practice_ready', { text, language: textLang, mode: saveMode, duration: secs });
  });

  socket.on('practice_finish', ({ typed, maxLen, mistakes } = {}) => {
    const p = socket.practice;
    if (!p || p.done || typeof typed !== 'string') return;
    if (typed.length > p.textArr.length * 2 + 10) return;
    const now = Date.now();

    let wpm, accuracy, timeSec;
    if (p.mode === 'timed') {
      if (now < p.startedAt + p.duration * 1000 - 2000) return; // the clock has not run out yet
      ({ wpm, accuracy } = calcTimedStats(p.textArr, typed, maxLen, mistakes, p.duration));
      timeSec = p.duration;
    } else {
      const s = calcStats(p.textArr, typed, maxLen, mistakes, p.startedAt, now);
      if (!s.finished) return;
      ({ wpm, accuracy } = s);
      timeSec = Math.max((now - p.startedAt) / 1000, 1);
    }

    p.done = true;
    try {
      saveScore(socket.user.id, wpm, accuracy, timeSec, null, null, p.language, p.mode);
    } catch (e) {
      console.error('Score save error:', e.message);
    }
    socket.emit('practice_result', {
      wpm,
      accuracy,
      time: timeSec.toFixed(1),
      language: p.language,
      mode: p.mode,
      duration: p.duration
    });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log(`User disconnected: ${socket.user?.username}`);
  });
});

// ========== Race flow ==========
function runCountdown(room) {
  let n = COUNTDOWN_SECONDS;
  io.to(room.code).emit('countdown', { n });
  room.countdownTimer = setInterval(() => {
    n--;
    if (n > 0) {
      io.to(room.code).emit('countdown', { n });
      return;
    }
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
    room.status = 'racing';
    room.startedAt = Date.now();
    io.to(room.code).emit('race_go', { startedAt: room.startedAt, timeLimit: room.timeLimit });
    // Race can never hang: it ends automatically when the time limit is reached.
    room.raceTimer = setTimeout(() => endRace(room), room.timeLimit * 1000);
  }, 1000);
}

function leaveRoom(socket) {
  const code = socket.roomCode;
  if (!code || !rooms[code]) {
    socket.roomCode = null;
    return;
  }

  const room = rooms[code];
  delete room.players[socket.id];
  socket.leave(code);
  socket.roomCode = null;

  const remaining = Object.keys(room.players);
  if (remaining.length === 0) {
    clearTimers(room);
    delete rooms[code];
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = remaining[0];
    room.hostUsername = room.players[remaining[0]].username;
  }

  io.to(code).emit('player_left', {
    room: publicRoom(room),
    leftUsername: socket.user?.username
  });

  // If everyone still in the race has already finished, close it out.
  if (room.status === 'racing' && Object.values(room.players).every((p) => p.finished)) {
    endRace(room);
  }
}

function endRace(room) {
  if (room.status === 'finished') return;
  clearTimers(room);
  room.status = 'finished';

  // Finished players first (already ranked), then DNF players by progress
  const dnf = Object.values(room.players)
    .filter((p) => !p.finished)
    .sort((a, b) => b.progress - a.progress)
    .map((p) => ({
      username: p.username,
      wpm: p.wpm,
      accuracy: p.accuracy,
      rank: null,
      time: null,
      finished: false,
      progress: Math.round(p.progress)
    }));

  io.to(room.code).emit('race_finished', {
    results: [...room.results, ...dnf],
    room: publicRoom(room)
  });
}

function publicRoom(room) {
  return {
    code: room.code,
    hostUsername: room.hostUsername,
    status: room.status,
    maxPlayers: room.maxPlayers,
    customText: room.customText,
    language: room.language,
    playerCount: Object.keys(room.players).length,
    players: Object.entries(room.players).map(([sid, p]) => ({
      socketId: sid,
      username: p.username,
      progress: p.progress,
      wpm: p.wpm,
      accuracy: p.accuracy,
      finished: p.finished,
      isHost: sid === room.hostId
    }))
  };
}

server.listen(PORT, () => {
  console.log(`🏔️ Mountain Type server running on http://localhost:${PORT}`);
});
