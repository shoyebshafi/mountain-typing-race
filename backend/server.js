require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const {
  registerUser,
  loginUser,
  saveScore,
  getLeaderboard,
  getUserStats,
  findUserById
} = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'mountain-race-secret-change-me-in-production';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getDefaultTexts() {
  return {
    bn: [
      "বাংলাদেশের প্রকৃতি অপরূপ সুন্দর। সবুজ মাঠ, নদী আর পাহাড় মিলেমিশে এক অনন্য দৃশ্য তৈরি করে।",
      "শিক্ষাই জাতির মেরুদণ্ড। শিক্ষিত জাতিই উন্নত জাতি। তাই সবাইকে শিক্ষিত হতে হবে।",
      "সময়ের মূল্য অপরিসীম। সময় নষ্ট না করে কাজে লাগাতে হবে। সময় চলে গেলে আর ফিরে আসে না।"
    ],
    en: [
      "The greatest glory in living lies not in never falling, but in rising every time we fall.",
      "Learning a new language opens many doors. It helps you understand different cultures and people around the world.",
      "Time is the most valuable resource we have. Once it is gone, you cannot get it back. Use it wisely every day."
    ]
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

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
  const stats = getUserStats(req.user.id);
  res.json({ user, stats });
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  res.json(getLeaderboard(limit));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.username} (${socket.id})`);

  socket.on('create_room', ({ customText, maxPlayers = 8 }) => {
    const code = generateRoomCode();
    const text = (customText && customText.trim().length > 20)
      ? customText.trim().slice(0, 800)
      : null;

    rooms[code] = {
      code,
      hostId: socket.id,
      hostUsername: socket.user.username,
      players: {},
      status: 'waiting',
      text: text || null,
      customText: !!text,
      maxPlayers: Math.min(Math.max(maxPlayers || 8, 2), 10),
      startedAt: null,
      language: 'bn'
    };

    rooms[code].players[socket.id] = {
      id: socket.user.id,
      username: socket.user.username,
      progress: 0,
      wpm: 0,
      accuracy: 100,
      finished: false,
      finishTime: null
    };

    socket.join(code);
    socket.roomCode = code;

    socket.emit('room_created', {
      code,
      room: publicRoom(rooms[code])
    });
    console.log(`Room created: ${code} by ${socket.user.username}`);
  });

  socket.on('join_room', ({ code }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) {
      return socket.emit('error_msg', { message: 'Room not found' });
    }
    if (room.status !== 'waiting') {
      return socket.emit('error_msg', { message: 'Race already started' });
    }
    if (Object.keys(room.players).length >= room.maxPlayers) {
      return socket.emit('error_msg', { message: 'Room is full' });
    }
    const alreadyIn = Object.values(room.players).some(p => p.username === socket.user.username);
    if (alreadyIn) {
      return socket.emit('error_msg', { message: 'You are already in this room' });
    }

    room.players[socket.id] = {
      id: socket.user.id,
      username: socket.user.username,
      progress: 0,
      wpm: 0,
      accuracy: 100,
      finished: false,
      finishTime: null
    };

    socket.join(code.toUpperCase());
    socket.roomCode = code.toUpperCase();

    io.to(code.toUpperCase()).emit('player_joined', {
      room: publicRoom(room)
    });
    socket.emit('joined_room', { room: publicRoom(room) });
  });

  socket.on('set_text', ({ text }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.status !== 'waiting') return;

    if (text && text.trim().length >= 20) {
      room.text = text.trim().slice(0, 800);
      room.customText = true;
    } else {
      room.text = null;
      room.customText = false;
    }
    io.to(socket.roomCode).emit('room_updated', { room: publicRoom(room) });
  });

  socket.on('start_race', ({ language = 'bn' }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.status !== 'waiting') return;
    if (Object.keys(room.players).length < 1) return;

    if (!room.text) {
      const texts = getDefaultTexts();
      const list = texts[language] || texts.en;
      room.text = list[Math.floor(Math.random() * list.length)];
      room.language = language;
    }

    room.status = 'racing';
    room.startedAt = Date.now();

    Object.values(room.players).forEach(p => {
      p.progress = 0;
      p.wpm = 0;
      p.accuracy = 100;
      p.finished = false;
      p.finishTime = null;
    });

    io.to(socket.roomCode).emit('race_started', {
      text: room.text,
      room: publicRoom(room)
    });
  });

  socket.on('progress', ({ progress, wpm, accuracy, finished }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'racing') return;
    const player = room.players[socket.id];
    if (!player || player.finished) return;

    player.progress = Math.min(100, Math.max(0, progress));
    player.wpm = wpm || 0;
    player.accuracy = accuracy || 100;

    if (finished && !player.finished) {
      player.finished = true;
      player.finishTime = Date.now();
      player.progress = 100;
    }

    io.to(socket.roomCode).emit('progress_update', {
      socketId: socket.id,
      username: player.username,
      progress: player.progress,
      wpm: player.wpm,
      accuracy: player.accuracy,
      finished: player.finished
    });

    const allFinished = Object.values(room.players).every(p => p.finished);
    if (allFinished) {
      endRace(room);
    }
  });

  socket.on('leave_room', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log(`User disconnected: ${socket.user?.username}`);
  });
});

function leaveRoom(socket) {
  const code = socket.roomCode;
  if (!code || !rooms[code]) return;

  const room = rooms[code];
  delete room.players[socket.id];
  socket.leave(code);
  socket.roomCode = null;

  if (room.hostId === socket.id) {
    const remaining = Object.keys(room.players);
    if (remaining.length === 0) {
      delete rooms[code];
      return;
    }
    room.hostId = remaining[0];
    room.hostUsername = room.players[remaining[0]].username;
  }

  io.to(code).emit('player_left', {
    room: publicRoom(room),
    leftUsername: socket.user?.username
  });
}

function endRace(room) {
  room.status = 'finished';

  const finishedPlayers = Object.values(room.players)
    .filter(p => p.finished)
    .sort((a, b) => a.finishTime - b.finishTime);

  finishedPlayers.forEach((p, idx) => {
    p.rank = idx + 1;
    try {
      const timeSec = (p.finishTime - room.startedAt) / 1000;
      saveScore(p.id, p.wpm, p.accuracy, timeSec, p.rank, room.code);
    } catch (e) {
      console.error('Score save error:', e.message);
    }
  });

  io.to(room.code).emit('race_finished', {
    results: finishedPlayers.map(p => ({
      username: p.username,
      wpm: p.wpm,
      accuracy: p.accuracy,
      rank: p.rank,
      time: ((p.finishTime - room.startedAt) / 1000).toFixed(1)
    })),
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
