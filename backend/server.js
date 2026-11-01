require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

const {
  registerUser,
  loginUser,
  saveScore,
  getLeaderboard,
  getUserStats,
  findUserById
} = require('./db');
const { pickText, detectLanguage } = require('./texts');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET is not set. Using a random secret; users will be logged out on every restart.');
}
const PORT = process.env.PORT || 3000;
const COUNTDOWN_SECONDS = 3;

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
const norm = (s) => String(s || '').normalize('NFC');
const toChars = (s) => Array.from(norm(s));

function correctPrefix(typedArr, textArr) {
  const n = Math.min(typedArr.length, textArr.length);
  let i = 0;
  while (i < n && typedArr[i] === textArr[i]) i++;
  return i;
}

// All stats are computed on the server from the typed text, so clients cannot fake them.
function calcStats(textArr, typed, maxLen, mistakes, startedAt, now) {
  const typedArr = toChars(typed);
  const prefix = correctPrefix(typedArr, textArr);
  const finished = prefix === textArr.length && typedArr.length === textArr.length;
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
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await loginUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
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
  socket.on('create_room', ({ customText, maxPlayers = 8 } = {}) => {
    if (socket.roomCode) leaveRoom(socket);

    const code = generateRoomCode();
    const cleaned = norm(customText).trim();
    const text = cleaned.length >= 20 ? cleaned.slice(0, 800) : null;

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
      maxPlayers: Math.min(Math.max(parseInt(maxPlayers) || 8, 2), 8),
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

    const cleaned = norm(text).trim();
    if (cleaned.length >= 20) {
      room.text = cleaned.slice(0, 800);
      room.customText = true;
      room.language = detectLanguage(room.text);
    } else {
      room.text = null;
      room.customText = false;
    }
    io.to(socket.roomCode).emit('room_updated', { room: publicRoom(room) });
  });

  socket.on('start_race', ({ language = 'en' } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;

    if (room.text) {
      room.language = detectLanguage(room.text);
    } else {
      room.language = language === 'bn' ? 'bn' : 'en';
      room.text = pickText(room.language, room.lastText);
    }
    room.textArr = toChars(room.text);
    room.timeLimit = Math.min(600, Math.max(60, Math.ceil(room.textArr.length / 1.5)));
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
      rank: player.rank
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

  // ---------- Practice (solo) ----------
  socket.on('practice_start', ({ language = 'en', customText } = {}) => {
    const cleaned = norm(customText).trim();
    let text, lang, mode;
    if (cleaned.length >= 20) {
      text = cleaned.slice(0, 800);
      lang = detectLanguage(text);
      mode = 'custom';
    } else {
      lang = language === 'bn' ? 'bn' : 'en';
      text = pickText(lang, socket.practice && socket.practice.text);
      mode = 'practice';
    }
    socket.practice = {
      text,
      textArr: toChars(text),
      language: lang,
      mode,
      startedAt: Date.now() + COUNTDOWN_SECONDS * 1000,
      done: false
    };
    socket.emit('practice_ready', { text, language: lang });
  });

  socket.on('practice_finish', ({ typed, maxLen, mistakes } = {}) => {
    const p = socket.practice;
    if (!p || p.done || typeof typed !== 'string') return;
    const now = Date.now();
    const s = calcStats(p.textArr, typed, maxLen, mistakes, p.startedAt, now);
    if (!s.finished) return;
    p.done = true;
    const timeSec = Math.max((now - p.startedAt) / 1000, 1);
    try {
      saveScore(socket.user.id, s.wpm, s.accuracy, timeSec, null, null, p.language, p.mode);
    } catch (e) {
      console.error('Score save error:', e.message);
    }
    socket.emit('practice_result', {
      wpm: s.wpm,
      accuracy: s.accuracy,
      time: timeSec.toFixed(1),
      language: p.language,
      mode: p.mode
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
  console.log(`🏔️ Mountain Typing Race server running on http://localhost:${PORT}`);
});
