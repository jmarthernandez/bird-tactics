# 🪶 Bird Tactics

A turn-based tactics brawl between two flocks of birds, in the spirit of
Into the Breach: an isometric pixel-art board where **positioning and shoving
matter more than raw damage**. Played peer-to-peer in the browser with a
friend: one player **hosts** (their browser holds the game), the other
**joins** with an invite link. No server of your own.

**Play it:** https://jmarthernandez.github.io/bird-tactics/

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

## How to play

Each turn, every one of your birds may **fly, then act** (attack *or* forage).
Click a bird → click a **blue** tile to fly → click a **red** tile to attack.
Hover a red tile first to **preview** the damage and pushes. Knock out the
whole enemy flock to win.

| Bird | Moves | Attack |
|---|---|---|
| Sparrow (3 HP) | Hops 4 tiles, must go around obstacles | **Peck Flurry**: neighbor takes 1, pushed back a tile |
| Hawk (4 HP) | Flies 3 tiles over anything | **Dive Bomb**: first bird in a straight line (up to 4) takes 2, pushed back |
| Owl (5 HP) | Flies 2 tiles over anything | **Screech**: *all* 4 neighbors take 1 and get blown outward, friends included |
| Crow (3 HP) | Flies 3 tiles over anything | **Pebble Drop**: lobbed 2-4 tiles over anything: 1 damage, and birds around the impact scatter |

- **Shoving is the game.** A bird pushed into a tree, rock, bush, pond or another
  bird takes **1 bump damage** (BONK), and so does a bird it's shoved into.
- **Friendly fire is on.** Owls screech at everyone; crows' pebbles scatter your own birds too.
- **Forage** instead of attacking to heal:
  - 🍓 **Berry bush**: a hurt bird standing next to ripe berries gets +2 HP.
  - 🪱 **Worm patch** (brown dirt): stand on it to get +1 HP **and** +1 damage on your next attack.
  - Food grows back after 4 turns. Sparrows and crows are scavengers: +1 HP from any food.
- **Undo** takes back a fly. Attacks and snacks are final.
- `A` = attack, `F` = forage, `Esc` = cancel.

## Customizing (no code needed)

All game data lives in `src/data/`:

- `birds.json`: bird types, including their **pixel art** (`sprite.pixels` is a
  grid of letters, `sprite.palette` maps each letter to a color). Each bird has an
  `attack` (`targeting`: `adjacent`, `projectile`, `artillery` or `self`; `damage`,
  `push`, `splashDamage`, `splashPush`) and `movement` patterns:
  - `"step"`: walk up to `maxSteps` tiles one at a time (`directions`: `"orthogonal"`, `"diagonal"`, `"all"`, or a list like `[[1,0],[0,1]]`)
  - `"slide"`: straight lines up to `maxRange`
  - `"leap"`: jump to fixed `offsets` like `[[1,2],[2,1]]`
  - `canJumpOver`: `true` lets the bird pass over trees/birds
  - `stats.health`, `stats.forageBonus`, and `nicknames`; `abilities` is a placeholder for later
- `map.json`: the board, one text row per line (`.` grass, `T` tree, `R` rock, `~` pond, `B` berry bush, `d` worm patch)
- `settings.json`: board size, `turnMode` (`"allUnits"` = every bird acts, or `"oneUnit"` = one bird per turn), starting team, `bumpDamage`, and food settings

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
    rules.ts       pure rules: movement, attacks & pushes, foraging, turns, winning
    rules.test.ts  rules tests (npm test)
  net/
    protocol.ts    message types + validation, PROTOCOL_VERSION
    host.ts        host: auth, approval, validates & broadcasts actions, autosave
    client.ts      joiner: sends actions, shows host's state, auto-reconnect
  storage/         IndexedDB saves, export/import, file link, migrate(); player identity
  ui/
    board.ts       isometric pixel-art board, animations, attack previews
    sprites.ts     pixel-art helpers + terrain art (trees, rocks, bushes)
    sfx.ts         tiny synthesized sound effects
    gameScreen.ts  the game screen; hostPanel.ts host settings
  main.ts          screens & routing
```

The core rule: **only `applyAction` in `rules.ts` changes the game.** The host runs
every action (its own included) through it; clients only send requests.
