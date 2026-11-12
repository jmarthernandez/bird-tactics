# 🪶 Bird Tactics

A turn-based grid tactics game where every unit is a bird, played peer-to-peer
in the browser with a friend. There's no server of your own: one player
**hosts** (their browser holds the game), the other **joins** with an invite link.

This is the **skeleton**: networking, turns, saving, privacy, and movement.
There's no combat or win condition yet.

---

## 1. Run it on your computer

You need [Node.js](https://nodejs.org) (the "LTS" version). Then, in a terminal
inside this folder:

```bash
npm install      # first time only: downloads the libraries
npm run dev      # starts the game at http://localhost:5173
```

To try multiplayer on one computer:

1. Open http://localhost:5173 in your normal browser window, enter a name, click **Host Game**.
2. Click **Copy** next to the invite link.
3. Open a **private/incognito window**, paste the link, enter a different name, click **Join Game**.
   (It has to be a separate private window, because each browser profile is one player.)
4. Back in the host window, click **Allow**.

Other commands:

```bash
npm test         # runs the movement/rules tests
npm run build    # makes the deployable site in the dist/ folder
```

## 2. Put it online

### Option A: GitHub Pages (set up already)
Every push to the `main` branch builds and publishes the site automatically
(see `.github/workflows/deploy.yml`). One-time setup on GitHub:
**repo → Settings → Pages → Build and deployment → Source: GitHub Actions**.
The game is then at `https://<your-username>.github.io/<repo-name>/`.

### Option B: Netlify Drop (no account setup needed)
1. Run `npm run build`.
2. Go to https://app.netlify.com/drop.
3. Drag the `dist` folder onto the page. You get a URL like `https://something.netlify.app`.

## 3. Play with a friend

1. Open your game URL, enter your name, click **Host Game**. You're **Blue**.
2. (Optional) Set a password in **Host settings** and click Save. Tell your friend the password separately.
3. Click **Copy** and send the invite link to your friend.
4. When they open it, you'll see "NAME wants to join". Click **Allow**. They're **Red**.
5. Take turns: click one of your birds, click a highlighted tile to move it. Each bird
   may move once per turn. **Undo** takes back moves before you click **End Turn**.

**Keep the host tab open** while playing. If you close it, your friend sees
"Host offline, retrying..." and reconnects automatically when you host again.
The game autosaves in your browser after every move. Come back days later,
click **Host Game (resume)**, and the same invite link works again.

## How the birds move

| Bird | Movement |
|---|---|
| 🐦 Sparrow | 1–2 steps in any direction, walking around obstacles |
| 🦅 Hawk | Straight lines (up/down/left/right) up to 4, blocked by trees & birds |
| 🦉 Owl | Diagonals up to 3, blocked by trees & birds |
| 🐦‍⬛ Crow | Knight-style L jump, flies over anything |

No bird can land on a tree or another bird.

## Customizing (no code needed)

All game data lives in `src/data/`:

- `birds.json`: bird types. Each has `movement` patterns:
  - `"step"`: walk up to `maxSteps` tiles one at a time (`directions`: `"orthogonal"`, `"diagonal"`, `"all"`, or a list like `[[1,0],[0,1]]`)
  - `"slide"`: straight lines up to `maxRange`
  - `"leap"`: jump to fixed `offsets` like `[[1,2],[2,1]]`
  - `canJumpOver`: `true` lets the bird pass over trees/birds
  - `stats` and `abilities` are placeholders for combat later
- `map.json`: the board, one text row per line (`.` = open, `T` = tree)
- `settings.json`: board size, `turnMode` (`"allUnits"` = move every bird, or `"oneUnit"` = chess-style one move per turn), starting team

The host can also change these mid-session without editing files: **Host settings →
Download Current Config**, edit the JSON, then **Load Config** (this starts a new game).

## Privacy & security

- The invite link contains a 128-bit random room id (it's in the `#` part of the URL, which browsers don't send to web servers).
- Every new player must be approved by the host. Approved players are remembered and get straight back in. The host can **Kick/Remove** them.
- Optional password, checked by the host before anything about the game is sent. Wrong password or denied = no game state, ever.
- Connections that don't authenticate within 10 seconds are closed.
- **Regenerate invite link** makes the old link stop working.
- Moves go directly between the two browsers (WebRTC). The free PeerJS cloud server is only used to help the browsers find each other.

## Saves

- **Autosave**: in the host's browser (IndexedDB), after every move.
- **Export Save / Import Save**: download/upload a `.json` backup (also how you'd move hosting to another computer).
- **Link save file on disk** (Chrome/Edge only): also autosaves to a real file you choose. You re-link it each session.
- The joining player stores only their own name and player id.

## Code map

```
src/
  data/            birds.json, map.json, settings.json  (default config)
  game/
    types.ts       all shared types: config, state, actions
    config.ts      default config + config validation
    rules.ts       pure rules: getValidMoves, applyAction, createInitialState
    rules.test.ts  movement & turn tests (npm test)
  net/
    protocol.ts    message types + validation, PROTOCOL_VERSION
    host.ts        host: auth, approval, validates & broadcasts actions, autosave
    client.ts      joiner: sends actions, shows host's state, auto-reconnect
  storage/         IndexedDB saves, export/import, file link, migrate(); player identity
  ui/              canvas board, game screen, host settings panel
  main.ts          screens & routing
```

The core rule: **only `applyAction` in `rules.ts` changes the game.** The host runs
every action (its own included) through it; clients only send requests.
