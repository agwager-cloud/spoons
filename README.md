# Spoons Classroom Game Starter

Online multiplayer classroom version of **Spoons**, built as a Knockout-style starter project.

## Stack

- Vite + TypeScript client
- Phaser scenes
- Colyseus + Node authoritative server
- Shared TypeScript package placeholder
- Local-first workflow, then Render server, then itch.io HTML5 client upload

## Scenes included

- `StartScene` — name input, 5-digit room code input, Host Game, Join Game, sound toggle, waiting message
- `LobbyScene` — room code, up to 40 players, host-only Start Game, Manage Players, kick controls, bot testing controls
- `GameScene` — private hand display, left/right neighbour names, pulse-based passing, clickable spoons, scramble state
- `ResultsScene` — round/champion display, multi-column player list, participation award spin, host-only Next Round / Play Again / Return to Lobby

## Recommended gameplay model

This starter uses a **simultaneous pulse** system:

- Each player has four cards.
- Players tap one card they want to pass left.
- Every 1.2 seconds, the server passes all selected cards at the same time.
- If a player has four of a kind, they can take the first spoon.
- Once the first spoon is taken, everyone can scramble for the remaining spoons.
- The player without a spoon is eliminated.

This is better for classrooms than fully chaotic real-time passing because it is fairer on iPads, easier to understand, and less likely to punish students on slower Wi-Fi.

## Local setup

From `C:\Projects\Spoons`:

```bash
npm install
npm run build
npm run dev
```

Open the client at:

```text
http://localhost:5173
```

The local server runs at:

```text
http://localhost:2567
```

Health check:

```text
http://localhost:2567/health
```

## Local testing flow

1. Open `http://localhost:5173` in one browser tab.
2. Enter a name and click **Host Game**.
3. Copy the 5-digit code.
4. Open another browser profile, incognito window, iPad, or different device.
5. Enter a different name and the code, then click **Join Game**.
6. Add bots in the lobby if you want to test with larger player counts.
7. Click **Start Game**.

Note: duplicate accounts from the same browser/device are blocked by a stored device ID, so use incognito/different devices for multi-human testing.

## Render notes for later

Suggested Render Web Service settings:

- Build command: `npm install && npm run build`
- Start command: `npm run server:start`
- Health path: `/health`
- Root directory: leave blank

## itch.io notes for later

Before building the itch.io client, set the Render server URL:

```bash
cd client
copy .env.example .env
```

Then edit `.env`:

```text
VITE_SERVER_URL=https://your-spoons-server.onrender.com
```

Build a ready-to-upload itch.io zip from the project root:

```bash
npm run zip:client
```

Upload `spoons-itch-client.zip` to itch.io. The zip will contain `index.html` at the root and uses relative Vite asset paths.

## Files to develop next

- `server/src/SpoonsRoom.ts` — authoritative game rules and room/player management
- `client/src/scenes/GameScene.ts` — main playable UI
- `client/src/scenes/ResultsScene.ts` — results, awards, next round flow
- `client/src/net/Net.ts` — connection details and Render URL handling

## Known MVP simplification

The starter uses card passing only, rather than modelling the physical dealer draw deck/trash pile exactly. This keeps 40-player classroom play fast and fair. A later hot fix can add a draw deck mechanic if you want more faithful physical Spoons behaviour.

## Hot fix 01 - local LAN connection fix

If the client is opened at a LAN address such as `http://192.168.x.x:5173`, the client now connects to `ws://192.168.x.x:2567` automatically. The starter no longer falls back to the placeholder Render URL during local testing.

For itch.io/hosted builds, set `VITE_SERVER_URL` before building the client.

## Hotfix 07 - Round flow and game-scene cleanup

- Slowed bot first-spoon and scramble reaction timing so human players have a fair chance to grab spoons.
- Removed the results screen between normal elimination rounds.
- After a player is out, the GameScene now shows a 5-second countdown and automatically deals the next round to the remaining players.
- Eliminated players become spectators and can watch the dealer's hand.
- ResultsScene now appears only when one champion remains.
- Final ResultsScene buttons are now Start New Game and Return to Lobby only.
- Participation award eligibility remains human-only and excludes disconnected players and late-join spectators.
- Cleaned GameScene layout so the Grab Spoon button no longer covers the active player list or hand area.

## Hotfix 13 - background music

- Adds `client/public/assets/audio/slimeyfoxbgm.mp3` as looping background music.
- Preloads the music safely with relative asset paths for itch.io.
- Sound toggle now pauses/resumes the shared background track across Start, Lobby, Game, and Results scenes.
- Music waits for the browser audio unlock event, so it should begin after the first user interaction when sound is enabled.

## Hotfix 15 — Render server build fix

Render was failing with:

```text
Cannot find module '/opt/render/project/src/server/dist/index.js'
```

Cause: Render was running `npm install` and then `npm run server:start`, but the TypeScript server had not been compiled, so `server/dist/index.js` did not exist.

Fix included in this hotfix:

```json
"server:start": "npm --workspace server run build && npm --workspace server run start",
"start": "npm run server:start",
"engines": { "node": "22.x" }
```

Recommended Render settings:

```text
Root Directory: leave blank
Build Command: npm install
Start Command: npm run server:start
Health Check Path: /health
```

Alternative Render build command, if preferred:

```text
npm install && npm run server:build
```

Then keep the start command as:

```text
npm run server:start
```

