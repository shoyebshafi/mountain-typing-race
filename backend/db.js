const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'game.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

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

// ---- Migrations (safe to run on an existing game.db) ----
const scoreCols = db.prepare('PRAGMA table_info(scores)').all().map((c) => c.name);
if (!scoreCols.includes('language')) {
  db.exec("ALTER TABLE scores ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
}
if (!scoreCols.includes('mode')) {
  // mode: 'race' | 'practice' | 'custom'
  db.exec("ALTER TABLE scores ADD COLUMN mode TEXT NOT NULL DEFAULT 'race'");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_scores_lang ON scores(language, wpm DESC)');

// ---- Prepared statements ----
const stmts = {
  createUser: db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  findUser: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  findUserById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),
  insertScore: db.prepare(`
    INSERT INTO scores (user_id, wpm, accuracy, time_seconds, rank, room_code, language, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  // Best score per user, per language. Custom-text games never count.
  topScores: db.prepare(`
    SELECT u.username, MAX(s.wpm) AS wpm, s.accuracy, s.time_seconds, s.played_at
    FROM scores s
    JOIN users u ON u.id = s.user_id
    WHERE s.language = ? AND s.mode != 'custom'
    GROUP BY s.user_id
    ORDER BY wpm DESC
    LIMIT ?
  `),
  userSummary: db.prepare(`
    SELECT
      MAX(wpm) AS best_wpm,
      AVG(wpm) AS avg_wpm,
      AVG(accuracy) AS avg_accuracy,
      COUNT(*) AS races,
      SUM(CASE WHEN mode = 'race' AND rank = 1 THEN 1 ELSE 0 END) AS wins
    FROM scores WHERE user_id = ?
  `),
  userByLanguage: db.prepare(`
    SELECT language, MAX(wpm) AS best_wpm, COUNT(*) AS races
    FROM scores WHERE user_id = ?
    GROUP BY language
  `),
  recentScores: db.prepare(`
    SELECT wpm, accuracy, time_seconds, rank, language, mode, played_at
    FROM scores WHERE user_id = ?
    ORDER BY played_at DESC, id DESC LIMIT 20
  `)
};

async function registerUser(username, password) {
  if (!username || username.length < 3 || username.length > 20) {
    throw new Error('Username must be 3-20 characters');
  }
  if (!password || password.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    throw new Error('Username can only contain letters, numbers and underscore');
  }

  const existing = stmts.findUser.get(username);
  if (existing) {
    throw new Error('Username already taken');
  }

  const hash = await bcrypt.hash(password, 10);
  const result = stmts.createUser.run(username, hash);
  return { id: Number(result.lastInsertRowid), username };
}

async function loginUser(username, password) {
  const user = stmts.findUser.get(username || '');
  if (!user) {
    throw new Error('Invalid username or password');
  }
  const match = await bcrypt.compare(password || '', user.password_hash);
  if (!match) {
    throw new Error('Invalid username or password');
  }
  return { id: user.id, username: user.username };
}

function saveScore(userId, wpm, accuracy, timeSeconds, rank, roomCode, language = 'en', mode = 'race') {
  stmts.insertScore.run(userId, wpm, accuracy, timeSeconds, rank, roomCode || null, language, mode);
}

function getLeaderboard(language = 'en', limit = 20) {
  return stmts.topScores.all(language === 'bn' ? 'bn' : 'en', limit);
}

function getUserStats(userId) {
  return {
    best: stmts.userSummary.get(userId),
    byLanguage: stmts.userByLanguage.all(userId),
    recent: stmts.recentScores.all(userId)
  };
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
