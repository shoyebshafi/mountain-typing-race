# 🏔️ Mountain Typing Race (Summit Type)

A multiplayer typing race game. Log in with a username and password, create a private room, and race your friends up the mountain. Supports English and Bangla (বাংলা).

## Features

- **Username + Password** login/register (no email or phone needed)
- **Custom rooms** with a private 6-character room code (2–8 players)
- **3-2-1 countdown** before every race, so everyone starts together
- **Real-time climbers** on an animated mountain, with a rank badge when you reach the summit
- **Rematch button**: the host can restart the room with a new text in one click
- **Practice mode**: solo training in English or Bangla (or with your own text)
- **Profile page**: best/average WPM, accuracy, wins, a WPM graph of your last 20 games and a recent games table
- **Separate leaderboards** for English and Bangla (best score per player)
- **Sound effects** (key clicks, countdown, finish) with a mute button
- **Bangla-safe typing**: text is Unicode-normalized so vowel signs like `ো` / `ৌ` are compared fairly on every keyboard
- **20 built-in texts** (10 English, 10 Bangla). Add more in `backend/texts.js`
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

If `JWT_SECRET` is not set, a random one is generated on each start (users will need to log in again after a restart). Always set it in production.

## How to play

1. Register, then log in.
2. **Create a room** (optionally paste your own text) and share the code, or **join** a friend's room.
3. The host chooses a language and presses **Start Race**.
4. After the 3-2-1 countdown, type the text. Fix mistakes to keep climbing.
5. When the race ends, the host can press **Race Again** for a rematch.

Custom-text games are saved to your profile but do not count for the leaderboard.

## Project structure

```
mountain-typing-race/
├── backend/
│   ├── server.js      # Express + Socket.io (rooms, countdown, validation, practice)
│   ├── db.js          # SQLite database + automatic migration
│   ├── texts.js       # Built-in race texts + language detection
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
