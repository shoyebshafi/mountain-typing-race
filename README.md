# 🏔️ Mountain Type

A multiplayer typing race game. Log in with a username and password, create a private room, and race your friends up the mountain. Supports English and Bangla (বাংলা).

## Features

- **Username + Password** login/register (no email or phone needed)
- **Open rooms**: switch on **Join anyone without Code** when creating a room, and any player can enter it with the **Join Random Room** button (the fullest waiting room is chosen first). Switched off (the default), a room is private and needs its code
- **Custom rooms** with a private 6-character room code. Up to 8 players can join, and the host can start the race with any number of players (2, 3, 4...)
- **3-2-1 countdown** before every race, so everyone starts together
- **A real rock-face climb**: every player has their own real rope hanging from an anchor bolt on a tall cliff. Your climber is an articulated human who climbs on **all four limbs** (diagonal hand and foot moves), with a live altitude meter, a rank badge and a victory pose at the summit. Want a photo instead? Drop a wide mountain photo at `frontend/img/mountain.jpg` and the game uses it as the background automatically
- **Records and history**: your best speed, average, accuracy, wins and the leaderboard come from all-time records that never expire. **Custom-text games never count** for records or the leaderboard; they appear only in your history. The history keeps your **last 20 games**, older ones are deleted to save space (your records are kept)
- **Player profiles**: click any name on the leaderboard to see that player's climber, stats and graph
- **Delete account**: at the bottom of your own profile (needs your password; deletes your scores too)
- **Climber editor** on your profile page: skin tone, hair style and color, jacket / hoodie / T-shirt / sleeveless, shorts or long pants, shoes, headwear, backpack and any color you like. Everyone in your race sees your climber
- **Your data is permanent**: users, scores, history, leaderboard and avatars live in a PostgreSQL database, so nothing is lost when the site redeploys or restarts
- **Single-box typing**: you type directly on the text you read. Typed text is highlighted step by step, mistakes turn red, and long passages scroll automatically
- **The winner has the highest WPM**, not the first one to finish. Places update live as players finish and are final when the race ends (ties: higher accuracy, then the faster finish)
- **Rematch button**: the host can restart the room with a new text in one click
- **Practice mode** with four options: Random Text, Custom Text, **30 second Test** and **60 second Test** (a quick typing speed test)
- **Profile page**: best/average WPM, accuracy, wins, a WPM graph of your last 20 games and a recent games table
- **Separate leaderboards** for English and Bangla (best score per player)
- **Sound effects** (key clicks, countdown, finish) with a mute button
- **Clear typing colors**: gray = still to type, a blue block = the letter to type now, green = typed right, red = only the part that is wrong (for Bangla the whole visible unit, so a wrong vowel sign can never hide)
- **Word-by-word scoring**: a mistake never stops the race, it ends when the last word is typed. A wrong word is left out of your speed (WPM) and it lowers your accuracy (right words / all words). After the race, "Words to practice" shows what the text said and what you typed
- **Bangla-safe typing**: text is Unicode-normalized, invisible zero-width characters are ignored, and keyboard differences (Bangla vs ASCII digits, `।` vs `.`) all count as correct, so the race always finishes when you finish typing
- **Always logged in**: you stay logged in on every device until you press Logout
- **Result box for room races** (inspired by typing-race sites): the moment you finish, a result box opens with your rank, WPM, accuracy, consistency and time, while you keep watching the other climbers and a live standings table. You can leave the room whenever you like, and the host can start a rematch when everyone is done
- **Huge random text storage**: about 280 sentences per language (and growing) in 6 topics: **Biology, Chemistry, Physics, Bengal History, Geography and Technology**, plus general passages, in both English and Bangla. Every race builds a fresh text of 20, 30, 40 or 60 words, and the game remembers what a room or player had recently, so texts do not come back again and again. Hosts and practice players can pick a topic and a length, or leave it on random. Add more sentences in `backend/topics.js`, `topics_extra_bn.js` and `topics_extra_en.js`
- **Fair play**: WPM, accuracy and finishing are calculated on the server; pasting is blocked; you must finish the text without errors
- **Races never hang**: every race has a time limit; players who do not finish appear as "Did not finish"

## Setup

### 1. Create a free database (once)

The game stores everything in PostgreSQL. A free [Neon](https://neon.tech) database is the easiest option: create a project and copy its **connection string** (it starts with `postgresql://`).

### 2. Run the server

```bash
cd backend
npm install
export DATABASE_URL="postgresql://...your connection string..."   # Windows PowerShell: $env:DATABASE_URL="..."
npm start
# or for development:
npm run dev
```

Open **http://localhost:3000** in your browser. The tables are created automatically on the first start.

### Environment variables (`backend/.env` locally, or the Environment tab on Render)

```
DATABASE_URL=postgresql://user:password@host/dbname   # required
PORT=3000
JWT_SECRET=optional-long-random-string                 # optional, see below
CORS_ORIGIN=https://your-site.example                  # only if the frontend is hosted on another domain
```

If `JWT_SECRET` is not set, a secret is generated once and stored in the database, so everyone stays logged in across restarts and redeploys.

## How to play

1. Register, then log in.
2. **Create a room** (switch on **Custom Text** if you want to paste your own text) and share the code, or **join** a friend's room.
3. The host chooses a language and presses **Start Race** whenever they are ready.
4. After the 3-2-1 countdown, click the text (it is focused for you) and start typing right on it. Fix mistakes to keep climbing.
5. When the race ends, the host can press **Race Again** for a rematch.

Custom-text games are saved to your profile but do not count for the leaderboard.

## Project structure

```
mountain-typing-race/
├── backend/
│   ├── server.js      # Express + Socket.io (rooms, countdown, validation, practice)
│   ├── db.js          # PostgreSQL storage (users, scores, avatars, login secret)
│   ├── avatar.js      # Validation of climber looks
│   ├── texts.js       # Random text generator (20/30/40/60 words), avoids recent texts
│   ├── topics.js      # Topic sentences (first list)
│   ├── topics_extra_bn.js  # More Bangla sentences + Geography and Technology
│   ├── topics_extra_en.js  # More English sentences + Geography and Technology
│   ├── package.json
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js
│       ├── scoring.js # Word-by-word scoring, shared by the browser and the server
│       └── hiker.js   # The climber: human figure, four-limb climbing, avatar options
└── README.md
```

## Tech stack

- **Backend**: Node.js, Express, Socket.io, pg (PostgreSQL), bcryptjs, JWT
- **Frontend**: Vanilla HTML/CSS/JS (Web Audio for sounds, inline SVG for the chart)
- **Database**: PostgreSQL (free Neon database recommended)

## Deploying on Render

1. Set the **Build Command** to `cd backend && npm install` and the **Start Command** to `cd backend && npm start`.
2. In the **Environment** tab add `DATABASE_URL` (your Neon connection string).
3. Never store data in files on Render's free plan: its disk is wiped on every deploy, restart and spin-down. That is why this project uses an external database.
