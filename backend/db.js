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
  connectionString: DATABASE_URL.replace('sslmode=require', 'sslmode=verify-full'),
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// How many games are kept in the history of each player. Older games are deleted to save space.
// The all-time records (best speed, average, wins) live in player_stats, so they are never lost.
const HISTORY_LIMIT = 20;

// Rebuild the all-time records from games that already exist (runs once, when player_stats is empty).
const BACKFILL_SQL = `
  INSERT INTO player_stats (user_id, language, best_wpm, best_accuracy, best_time, best_at, games, sum_wpm, sum_accuracy, wins)
  SELECT s.user_id, s.language, MAX(s.wpm),
         (SELECT b.accuracy FROM scores b WHERE b.user_id = s.user_id AND b.language = s.language AND b.mode <> 'custom' ORDER BY b.wpm DESC, b.id DESC LIMIT 1),
         (SELECT b.time_seconds FROM scores b WHERE b.user_id = s.user_id AND b.language = s.language AND b.mode <> 'custom' ORDER BY b.wpm DESC, b.id DESC LIMIT 1),
         (SELECT b.played_at FROM scores b WHERE b.user_id = s.user_id AND b.language = s.language AND b.mode <> 'custom' ORDER BY b.wpm DESC, b.id DESC LIMIT 1),
         COUNT(*), SUM(s.wpm), SUM(s.accuracy),
         SUM(CASE WHEN s.mode = 'race' AND s.place_no = 1 THEN 1 ELSE 0 END)
  FROM scores s
  WHERE s.mode <> 'custom'
  GROUP BY s.user_id, s.language`;

// Keep only the newest HISTORY_LIMIT games of every player.
const TRIM_ALL_SQL = `
  DELETE FROM scores WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY played_at DESC, id DESC) AS rn FROM scores
    ) ranked
    WHERE rn > ${HISTORY_LIMIT}
  )`;

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
      place_no INTEGER,
      room_code TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      mode TEXT NOT NULL DEFAULT 'race',
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);
    CREATE INDEX IF NOT EXISTS idx_scores_lang ON scores(language, wpm DESC);

    -- All-time records: one small row per player and language. Custom-text games are never counted here.
    CREATE TABLE IF NOT EXISTS player_stats (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      best_wpm REAL NOT NULL DEFAULT 0,
      best_accuracy REAL NOT NULL DEFAULT 0,
      best_time REAL NOT NULL DEFAULT 0,
      best_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      games INTEGER NOT NULL DEFAULT 0,
      sum_wpm DOUBLE PRECISION NOT NULL DEFAULT 0,
      sum_accuracy DOUBLE PRECISION NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, language)
    );
  `);

  // Games saved before player_stats existed: turn them into records first, then trim the history.
  const have = await pool.query('SELECT COUNT(*)::int AS n FROM player_stats');
  if (have.rows[0].n === 0) await pool.query(BACKFILL_SQL);
  await pool.query(TRIM_ALL_SQL);
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

// Saves one finished game:
//  - it always goes into the history (newest 20 per player are kept),
//  - and, unless it used custom text, it also updates the player's all-time records.
async function saveScore(userId, wpm, accuracy, timeSeconds, placeNo, roomCode, language = 'en', mode = 'race') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO scores (user_id, wpm, accuracy, time_seconds, place_no, room_code, language, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, wpm, accuracy, timeSeconds, placeNo, roomCode || null, language, mode]
    );
    if (mode !== 'custom') {
      await client.query(
        `INSERT INTO player_stats (user_id, language, best_wpm, best_accuracy, best_time, best_at, games, sum_wpm, sum_accuracy, wins)
         VALUES ($1::int, $2::text, $3::real, $4::real, $5::real, NOW(), 1, $6::double precision, $7::double precision, $8::int)
         ON CONFLICT (user_id, language) DO UPDATE SET
           best_accuracy = CASE WHEN EXCLUDED.best_wpm > player_stats.best_wpm THEN EXCLUDED.best_accuracy ELSE player_stats.best_accuracy END,
           best_time = CASE WHEN EXCLUDED.best_wpm > player_stats.best_wpm THEN EXCLUDED.best_time ELSE player_stats.best_time END,
           best_at = CASE WHEN EXCLUDED.best_wpm > player_stats.best_wpm THEN EXCLUDED.best_at ELSE player_stats.best_at END,
           best_wpm = GREATEST(player_stats.best_wpm, EXCLUDED.best_wpm),
           games = player_stats.games + 1,
           sum_wpm = player_stats.sum_wpm + EXCLUDED.sum_wpm,
           sum_accuracy = player_stats.sum_accuracy + EXCLUDED.sum_accuracy,
           wins = player_stats.wins + EXCLUDED.wins`,
        [userId, language, wpm, accuracy, timeSeconds, wpm, accuracy, mode === 'race' && placeNo === 1 ? 1 : 0]
      );
    }
    await client.query(
      `DELETE FROM scores WHERE user_id = $1 AND id NOT IN (
         SELECT id FROM scores WHERE user_id = $1 ORDER BY played_at DESC, id DESC LIMIT ${HISTORY_LIMIT}
       )`,
      [userId]
    );
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (ignore) { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}

// Best speed of every player, per language (custom-text games are not counted).
async function getLeaderboard(language = 'en', limit = 20) {
  const r = await pool.query(
    `SELECT u.username, p.best_wpm AS wpm, p.best_accuracy AS accuracy, p.best_time AS time_seconds, p.best_at AS played_at
     FROM player_stats p JOIN users u ON u.id = p.user_id
     WHERE p.language = $1
     ORDER BY p.best_wpm DESC, p.best_at ASC
     LIMIT $2`,
    [language === 'bn' ? 'bn' : 'en', limit]
  );
  return r.rows;
}

// Records come from player_stats (all-time, no custom text). History is the newest games, custom text included.
async function getUserStats(userId) {
  const [best, byLanguage, recent] = await Promise.all([
    pool.query(
      `SELECT MAX(best_wpm)::float AS best_wpm,
              (SUM(sum_wpm) / NULLIF(SUM(games), 0))::float AS avg_wpm,
              (SUM(sum_accuracy) / NULLIF(SUM(games), 0))::float AS avg_accuracy,
              COALESCE(SUM(games), 0)::int AS races,
              COALESCE(SUM(wins), 0)::int AS wins
       FROM player_stats WHERE user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT language, best_wpm::float AS best_wpm, games::int AS races
       FROM player_stats WHERE user_id = $1 ORDER BY language`,
      [userId]
    ),
    pool.query(
      `SELECT wpm, accuracy, time_seconds, place_no AS rank, language, mode, played_at
       FROM scores WHERE user_id = $1
       ORDER BY played_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
      [userId]
    )
  ]);
  return { best: best.rows[0], byLanguage: byLanguage.rows, recent: recent.rows };
}

async function findUserById(id) {
  const r = await pool.query('SELECT id, username, created_at, avatar FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function findUserByUsername(username) {
  const r = await pool.query(
    'SELECT id, username, created_at, avatar FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );
  return r.rows[0] || null;
}

// Permanently deletes the account (after checking the password). Scores go with it (ON DELETE CASCADE).
async function deleteUser(userId, password) {
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!r.rows[0]) throw new Error('Account not found');
  const ok = await bcrypt.compare(password || '', r.rows[0].password_hash);
  if (!ok) throw new Error('Wrong password');
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
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
  HISTORY_LIMIT,
  findUserById,
  findUserByUsername,
  deleteUser,
  getAvatar,
  setAvatar
};
