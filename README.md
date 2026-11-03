# 🏔️ Mountain Type

A multiplayer typing race game. Log in with a username and password, create a private room, and race your friends up the mountain. Supports English and Bangla (বাংলা).

## Features

- **Username + Password** login/register (no email or phone needed)
- **Custom rooms** with a private 6-character room code. Up to 8 players can join, and the host can start the race with any number of players (2, 3, 4...)
- **3-2-1 countdown** before every race, so everyone starts together
- **A real mountain trail**: every correct character moves your hiker along a switchback path from base camp to the summit (live altitude meter, walking animation, rank badge and a victory pose at the top)
- **Single-box typing**: you type directly on the text you read. Typed text is highlighted step by step, mistakes turn red, and long passages scroll automatically
- **Rematch button**: the host can restart the room with a new text in one click
- **Practice mode** with four options: Random Text, Custom Text, **30 second Test** and **60 second Test** (a quick typing speed test)
- **Profile page**: best/average WPM, accuracy, wins, a WPM graph of your last 20 games and a recent games table
- **Separate leaderboards** for English and Bangla (best score per player)
- **Sound effects** (key clicks, countdown, finish) with a mute button
- **Bangla-safe typing**: text is Unicode-normalized, invisible zero-width characters are ignored, and keyboard differences (Bangla vs ASCII digits, `।` vs `.`) all count as correct, so the race always finishes when you finish typing
- **Always logged in**: you stay logged in on every device until you press Logout
- **Result box for room races** (inspired by typing-race sites): the moment you finish, a result box opens with your rank, WPM, accuracy, consistency and time, while you keep watching the other climbers and a live standings table. You can leave the room whenever you like, and the host can start a rematch when everyone is done
- **Huge random text storage**: every race builds a fresh text of 20, 30, 40 or 60 words (random) from general passages and topic sentences: **Biology, Chemistry, Physics and Bengal History**, in both English and Bangla. Hosts and practice players can pick a topic and a length, or leave it on random. Add more sentences in `backend/topics.js`
- **Fair play**: WPM, accuracy and finishing are calculated on the server; pasting is blocked; you must finish the text without errors
- **Races never hang**: every race has a time limit; players who do not finish appear as "Did not finish"

## Setup

```bash
cd backend
npm install
npm start
# or for development:
npm run dev
```

Open **http://localhost:3000** in your browser.

### Optional environment variables (`backend/.env`)

```
PORT=3000
JWT_SECRET=put-a-long-random-string-here
CORS_ORIGIN=https://your-site.example   # only needed if the frontend is hosted on a different domain
```

If `JWT_SECRET` is not set, a secret is generated once and saved in `backend/.jwt_secret` (it is git-ignored), so logins survive restarts. On hosting with a temporary disk, set the `JWT_SECRET` environment variable instead.

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
│   ├── db.js          # SQLite database + automatic migration
│   ├── texts.js       # Random text generator (20/30/40/60 words) + general passages
│   ├── topics.js      # Biology, chemistry, physics and Bengal history sentences
│   ├── package.json
│   └── game.db        # (created automatically)
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
└── README.md
```

## Tech stack

- **Backend**: Node.js, Express, Socket.io, better-sqlite3, bcrypt, JWT
- **Frontend**: Vanilla HTML/CSS/JS (Web Audio for sounds, inline SVG for the chart)
- **Database**: SQLite (file based). Existing `game.db` files are upgraded automatically.

## Deployment note

SQLite stores data in `backend/game.db`. On hosts with a temporary disk (e.g. free Render/Railway plans) this file can be wiped on redeploy. Use a persistent disk/volume for real use.
