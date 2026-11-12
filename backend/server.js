require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

const {
  init: initDb,
  getJwtSecret,
  registerUser,
  loginUser,
  saveScore,
  getLeaderboard,
  getUserStats,
  findUserById,
  getAvatar,
  setAvatar,
  findUserByUsername,
  deleteUser
} = require('./db');
const { sanitizeAvatar } = require('./avatar');
const Scoring = require('../frontend/js/scoring.js'); // one scoring code for the browser and the server
const { buildTextParts, detectLanguage } = require('./texts');

// The signing secret is kept in the database (or in the JWT_SECRET env var), so logins survive every restart.
let JWT_SECRET = process.env.JWT_SECRET || null;
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

// All scoring is done here on the server from the typed text, so nobody can fake a result.
// The rules (word by word, mistakes never stop the race, wrong words are left out of the speed)
// live in frontend/js/scoring.js and are shared with the browser.
function calcStats(prep, typed, startedAt, now) {
  const ev = Scoring.evaluate(prep, typed, {});
  const minutes = Math.max((now - startedAt) / 60000, 1 / 60);
  return {
    finished: ev.finished,
    wpm: Math.min(400, Math.round(ev.wpmChars / 5 / minutes)),
    accuracy: ev.accuracy,
    progress: (ev.cursor / prep.length) * 100
  };
}

// Timed tests: the clock ends the test, not the text.
function calcTimedStats(prep, typed, durationSec) {
  const ev = Scoring.evaluate(prep, typed, { timed: true, timedEnd: true });
  return {
    wpm: Math.min(400, Math.round(ev.wpmChars / 5 / (durationSec / 60))),
    accuracy: ev.accuracy
  };
}

// Builds a fresh text that avoids what this room / player had recently, so texts do not repeat.
function freshText(memories, lang, words) {
  const built = buildTextParts(lang, words, new Set(memories.flat()));
  memories.forEach((m) => {
    m.push(...built.parts);
    while (m.length > 200) m.shift();
  });
  return cleanText(built.text);
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

function newPlayer(user, avatar) {
  return {
    id: user.id,
    username: user.username,
    avatar: avatar || null,
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
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar || null } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await loginUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_LIFETIME });
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar || null } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user, stats: await getUserStats(req.user.id) });
  } catch (err) {
    console.error('/api/me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Anyone who is logged in can look at another player's profile (stats and climber only).
app.get('/api/users/:username', authMiddleware, async (req, res) => {
  try {
    const user = await findUserByUsername(String(req.params.username || '').slice(0, 40));
    if (!user) return res.status(404).json({ error: 'Player not found' });
    res.json({ user: { id: user.id, username: user.username, avatar: user.avatar, created_at: user.created_at }, stats: await getUserStats(user.id) });
  } catch (err) {
    console.error('/api/users error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete my own account for good (needs the password). Scores are deleted with it.
app.delete('/api/me', authMiddleware, async (req, res) => {
  try {
    await deleteUser(req.user.id, (req.body && req.body.password) || '');
    res.json({ ok: true });
  } catch (err) {
    const known = ['Wrong password', 'Account not found'];
    if (!known.includes(err.message)) console.error('delete account error:', err.message);
    res.status(known.includes(err.message) ? 400 : 500).json({ error: known.includes(err.message) ? err.message : 'Server error' });
  }
});

app.put('/api/avatar', authMiddleware, async (req, res) => {
  const avatar = sanitizeAvatar(req.body && req.body.avatar);
  if (!avatar) return res.status(400).json({ error: 'Invalid avatar' });
  try {
    await setAvatar(req.user.id, avatar);
    res.json({ avatar });
  } catch (err) {
    console.error('/api/avatar error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const lang = req.query.lang === 'bn' ? 'bn' : 'en';
    res.json(await getLeaderboard(lang, limit));
  } catch (err) {
    console.error('/api/leaderboard error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ========== Socket.IO ==========
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return next(new Error('Invalid token'));
  }
  try {
    socket.avatar = await getAvatar(socket.user.id);
  } catch (e) {
    socket.avatar = null;
  }
  next();
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.username} (${socket.id})`);

  // ---------- Rooms ----------
  socket.on('create_room', ({ customText, isPublic } = {}) => {
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
      prep: null,
      maxPlayers: MAX_PLAYERS,
      isPublic: !!isPublic, // open room: anyone can join with "Join Random Room"
      createdAt: Date.now(),
      recent: [],
      startedAt: null,
      timeLimit: 0,
      language: text ? detectLanguage(text) : 'en',
      results: [],
      countdownTimer: null,
      raceTimer: null
    };

    rooms[code].players[socket.id] = newPlayer(socket.user, socket.avatar);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room_created', { code, room: publicRoom(rooms[code]) });
    console.log(`Room created: ${code} by ${socket.user.username}`);
  });

  socket.on('join_room', ({ code } = {}) => joinRoom(socket, String(code || '').trim().toUpperCase()));

  // "Join Random Room": go into any open room that is waiting for players.
  // The fullest room is chosen first, so players end up together instead of spread out.
  socket.on('join_random', () => {
    const open = Object.values(rooms).filter((r) =>
      r.isPublic &&
      r.status === 'waiting' &&
      Object.keys(r.players).length < r.maxPlayers &&
      !Object.values(r.players).some((p) => p.username === socket.user.username)
    );
    if (!open.length) {
      return socket.emit('error_msg', {
        message: 'No open room right now. Create one with "Join anyone without Code" turned on, or try again in a moment.'
      });
    }
    open.sort((a, b) => Object.keys(b.players).length - Object.keys(a.players).length || a.createdAt - b.createdAt);
    joinRoom(socket, open[0].code);
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

  socket.on('start_race', ({ language = 'en', words } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;

    if (room.text) {
      room.language = detectLanguage(room.text);
    } else {
      room.language = language === 'bn' ? 'bn' : 'en';
      room.text = freshText([room.recent, (socket.recent = socket.recent || [])], room.language, words);
    }
    room.prep = Scoring.prepare(room.text);
    room.timeLimit = Math.min(900, Math.max(60, Math.ceil(room.prep.length / 1.5)));
    room.results = [];
    room.saved = false;
    resetPlayers(room);
    room.status = 'countdown';

    io.to(room.code).emit('race_starting', { text: room.text, room: publicRoom(room) });
    runCountdown(room);
  });

  socket.on('progress', ({ typed } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'racing') return;
    const player = room.players[socket.id];
    if (!player || player.finished) return;
    if (typeof typed !== 'string' || typed.length > room.text.length * 2 + 10) return;

    const now = Date.now();
    const s = calcStats(room.prep, typed, room.startedAt, now);
    player.progress = s.progress;
    player.wpm = s.wpm;
    player.accuracy = s.accuracy;

    if (s.finished) {
      player.finished = true;
      player.finishTime = now;
      player.progress = 100;
      const timeSec = (now - room.startedAt) / 1000;
      room.results.push({
        socketId: socket.id,
        userId: player.id,
        username: player.username,
        wpm: player.wpm,
        accuracy: player.accuracy,
        timeSec,
        time: timeSec.toFixed(1),
        rank: null,
        finished: true
      });
      assignRanks(room); // the place goes by speed (WPM), not by who finished first
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
    if (s.finished) {
      // a slower finisher can still be faster in WPM, so everyone's current place may change
      io.to(room.code).emit('ranks_update', {
        ranks: room.results.map((r) => ({ socketId: r.socketId, username: r.username, rank: r.rank }))
      });
    }

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

  // The player saved a new look in their profile
  socket.on('avatar_updated', async () => {
    try {
      socket.avatar = await getAvatar(socket.user.id);
      const room = rooms[socket.roomCode];
      if (room && room.players[socket.id]) room.players[socket.id].avatar = socket.avatar;
    } catch (e) { /* ignore */ }
  });

  // ---------- Practice (solo): random text, custom text, 30s / 60s tests ----------
  socket.on('practice_start', ({ mode = 'random', duration, language = 'en', words, customText } = {}) => {
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
      text = freshText([(socket.recent = socket.recent || [])], lang, secs === 60 ? 260 : 140);
      saveMode = 'timed';
    } else {
      text = freshText([(socket.recent = socket.recent || [])], lang, words);
      saveMode = 'practice';
    }

    socket.practice = {
      text,
      prep: Scoring.prepare(text),
      language: textLang,
      mode: saveMode,
      duration: secs,
      startedAt: Date.now() + COUNTDOWN_SECONDS * 1000,
      done: false
    };
    socket.emit('practice_ready', { text, language: textLang, mode: saveMode, duration: secs });
  });

  socket.on('practice_finish', ({ typed } = {}) => {
    const p = socket.practice;
    if (!p || p.done || typeof typed !== 'string') return;
    if (typed.length > p.prep.length * 2 + 10) return;
    const now = Date.now();

    let wpm, accuracy, timeSec;
    if (p.mode === 'timed') {
      if (now < p.startedAt + p.duration * 1000 - 2000) return; // the clock has not run out yet
      ({ wpm, accuracy } = calcTimedStats(p.prep, typed, p.duration));
      timeSec = p.duration;
    } else {
      const s = calcStats(p.prep, typed, p.startedAt, now);
      if (!s.finished) return;
      ({ wpm, accuracy } = s);
      timeSec = Math.max((now - p.startedAt) / 1000, 1);
    }

    p.done = true;
    saveScore(socket.user.id, wpm, accuracy, timeSec, null, null, p.language, p.mode)
      .catch((e) => console.error('Score save error:', e.message));
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

function joinRoom(socket, roomCode) {
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

  room.players[socket.id] = newPlayer(socket.user, socket.avatar);
  socket.join(roomCode);
  socket.roomCode = roomCode;

  io.to(roomCode).emit('player_joined', { room: publicRoom(room) });
  socket.emit('joined_room', { room: publicRoom(room) });
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
    if (room.status === 'racing') saveResults(room);
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

// Places go by speed: the highest WPM is first.
// Ties: the higher accuracy wins, then the faster finish.
function assignRanks(room) {
  room.results.sort((a, b) => b.wpm - a.wpm || b.accuracy - a.accuracy || a.timeSec - b.timeSec);
  room.results.forEach((r, i) => {
    r.rank = i + 1;
    const p = room.players[r.socketId];
    if (p) p.rank = r.rank;
  });
}

// The final places are known only when the race is over, so scores are saved now (once).
function saveResults(room) {
  if (room.saved) return;
  room.saved = true;
  assignRanks(room);
  room.results.forEach((r) => {
    saveScore(
      r.userId, r.wpm, r.accuracy, r.timeSec, r.rank,
      room.code, room.language, room.customText ? 'custom' : 'race'
    ).catch((e) => console.error('Score save error:', e.message));
  });
}

function endRace(room) {
  if (room.status === 'finished') return;
  clearTimers(room);
  room.status = 'finished';
  saveResults(room);

  // Finished players first (ranked by WPM), then players who did not finish, by progress
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
    results: [
      ...room.results.map((r) => ({ username: r.username, wpm: r.wpm, accuracy: r.accuracy, rank: r.rank, time: r.time, finished: true })),
      ...dnf
    ],
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
    isPublic: !!room.isPublic,
    language: room.language,
    playerCount: Object.keys(room.players).length,
    players: Object.entries(room.players).map(([sid, p]) => ({
      socketId: sid,
      username: p.username,
      avatar: p.avatar,
      progress: p.progress,
      wpm: p.wpm,
      accuracy: p.accuracy,
      finished: p.finished,
      isHost: sid === room.hostId
    }))
  };
}

(async () => {
  await initDb();
  if (!JWT_SECRET) JWT_SECRET = await getJwtSecret();
  server.listen(PORT, () => {
    console.log(`🏔️ Mountain Type server running on http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error('Failed to start the server:', err);
  process.exit(1);
});
