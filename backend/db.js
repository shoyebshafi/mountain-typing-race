// PostgreSQL storage. A free Neon (or any Postgres) database keeps users, scores, avatars and the
// login secret safe across redeploys, restarts and spin-downs, which a local file can not do on Render's free plan.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('\n[error] DATABASE_URL is not set.');
  console.error('Create a free Postgres database (for example on neon.tech) and set DATABASE_URL to its connection string.\n');
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wpm REAL NOT NULL,
      accuracy REAL NOT NULL,
      time_seconds REAL NOT NULL,
      placing INTEGER,
      room_code TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      mode TEXT NOT NULL DEFAULT 'race',
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);
    CREATE INDEX IF NOT EXISTS idx_scores_lang ON scores(language, wpm DESC);
  `);
  console.log('[db] ready');
}

// The login signing secret lives in the database too, so everyone stays logged in after a redeploy.
async function getJwtSecret() {
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('jwt_secret', $1) ON CONFLICT (key) DO NOTHING",
    [crypto.randomBytes(48).toString('hex')]
  );
  const r = await pool.query("SELECT value FROM settings WHERE key = 'jwt_secret'");
  return r.rows[0].value;
}

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
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, hash]
    );
    return { id: r.rows[0].id, username, avatar: null };
  } catch (e) {
    if (e.code === '23505') throw new Error('Username already taken');
    throw e;
  }
}

async function loginUser(username, password) {
  const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username || '']);
  const user = r.rows[0];
  if (!user) throw new Error('Invalid username or password');
  const match = await bcrypt.compare(password || '', user.password_hash);
  if (!match) throw new Error('Invalid username or password');
  return { id: user.id, username: user.username, avatar: user.avatar || null };
}

async function saveScore(userId, wpm, accuracy, timeSeconds, placing, roomCode, language = 'en', mode = 'race') {
  await pool.query(
    `INSERT INTO scores (user_id, wpm, accuracy, time_seconds, placing, room_code, language, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, wpm, accuracy, timeSeconds, placing, roomCode || null, language, mode]
  );
}

// Best score per player, per language. Custom-text games never count.
async function getLeaderboard(language = 'en', limit = 20) {
  const r = await pool.query(
    `SELECT username, wpm, accuracy, time_seconds, played_at FROM (
       SELECT DISTINCT ON (s.user_id) u.username, s.wpm, s.accuracy, s.time_seconds, s.played_at
       FROM scores s JOIN users u ON u.id = s.user_id
       WHERE s.language = $1 AND s.mode <> 'custom'
       ORDER BY s.user_id, s.wpm DESC
     ) best
     ORDER BY wpm DESC
     LIMIT $2`,
    [language === 'bn' ? 'bn' : 'en', limit]
  );
  return r.rows;
}

async function getUserStats(userId) {
  const [best, byLanguage, recent] = await Promise.all([
    pool.query(
      `SELECT MAX(wpm)::float AS best_wpm, AVG(wpm)::float AS avg_wpm, AVG(accuracy)::float AS avg_accuracy,
              COUNT(*)::int AS races,
              COALESCE(SUM(CASE WHEN mode = 'race' AND placing = 1 THEN 1 ELSE 0 END), 0)::int AS wins
       FROM scores WHERE user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT language, MAX(wpm)::float AS best_wpm, COUNT(*)::int AS races
       FROM scores WHERE user_id = $1 GROUP BY language`,
      [userId]
    ),
    pool.query(
      `SELECT wpm, accuracy, time_seconds, placing AS rank, language, mode, played_at
       FROM scores WHERE user_id = $1
       ORDER BY played_at DESC, id DESC LIMIT 20`,
      [userId]
    )
  ]);
  return { best: best.rows[0], byLanguage: byLanguage.rows, recent: recent.rows };
}

async function findUserById(id) {
  const r = await pool.query('SELECT id, username, created_at, avatar FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function getAvatar(userId) {
  const r = await pool.query('SELECT avatar FROM users WHERE id = $1', [userId]);
  return (r.rows[0] && r.rows[0].avatar) || null;
}

async function setAvatar(userId, avatar) {
  await pool.query('UPDATE users SET avatar = $2::jsonb WHERE id = $1', [userId, JSON.stringify(avatar)]);
}

module.exports = {
  pool,
  init,
  getJwtSecret,
  registerUser,
  loginUser,
  saveScore,
  getLeaderboard,
  getUserStats,
  findUserById,
  getAvatar,
  setAvatar
};
