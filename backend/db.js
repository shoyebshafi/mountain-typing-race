const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'game.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    wpm REAL NOT NULL,
    accuracy REAL NOT NULL,
    time_seconds REAL NOT NULL,
    rank INTEGER,
    room_code TEXT,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);
  CREATE INDEX IF NOT EXISTS idx_scores_wpm ON scores(wpm DESC);
`);

// Prepared statements
const stmts = {
  createUser: db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  findUser: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  findUserById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),
  insertScore: db.prepare(`
    INSERT INTO scores (user_id, wpm, accuracy, time_seconds, rank, room_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  topScores: db.prepare(`
    SELECT u.username, s.wpm, s.accuracy, s.time_seconds, s.played_at
    FROM scores s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.wpm DESC
    LIMIT ?
  `),
  userBest: db.prepare(`
    SELECT MAX(wpm) as best_wpm, AVG(wpm) as avg_wpm, COUNT(*) as races
    FROM scores WHERE user_id = ?
  `),
  recentScores: db.prepare(`
    SELECT wpm, accuracy, time_seconds, rank, played_at
    FROM scores WHERE user_id = ?
    ORDER BY played_at DESC LIMIT 10
  `)
};

async function registerUser(username, password) {
  if (!username || username.length < 3 || username.length > 20) {
    throw new Error('Username must be 3-20 characters');
  }
  if (!password || password.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  // Simple username validation
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    throw new Error('Username can only contain letters, numbers and underscore');
  }

  const existing = stmts.findUser.get(username);
  if (existing) {
    throw new Error('Username already taken');
  }

  const hash = await bcrypt.hash(password, 10);
  const result = stmts.createUser.run(username, hash);
  return { id: result.lastInsertRowid, username };
}

async function loginUser(username, password) {
  const user = stmts.findUser.get(username);
  if (!user) {
    throw new Error('Invalid username or password');
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    throw new Error('Invalid username or password');
  }
  return { id: user.id, username: user.username };
}

function saveScore(userId, wpm, accuracy, timeSeconds, rank, roomCode) {
  stmts.insertScore.run(userId, wpm, accuracy, timeSeconds, rank, roomCode || null);
}

function getLeaderboard(limit = 20) {
  return stmts.topScores.all(limit);
}

function getUserStats(userId) {
  const best = stmts.userBest.get(userId);
  const recent = stmts.recentScores.all(userId);
  return { best, recent };
}

module.exports = {
  db,
  registerUser,
  loginUser,
  saveScore,
  getLeaderboard,
  getUserStats,
  findUserById: (id) => stmts.findUserById.get(id)
};
