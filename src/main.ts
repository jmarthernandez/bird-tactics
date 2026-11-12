// Entry point: decides which screen to show (lobby, join, waiting, game)
// and wires the screens to a HostSession or ClientSession.

import "./style.css";
import { DEFAULT_CONFIG } from "./game/config";
import { createInitialState, sideOf } from "./game/rules";
import { ClientSession } from "./net/client";
import { HostSession, newSave } from "./net/host";
import { MAX_NAME } from "./net/protocol";
import { loadIdentity, saveIdentity, type Identity } from "./storage/identity";
import { clearDb, loadFromDb, type SaveData } from "./storage/save";
import { h, setChildren, toast } from "./ui/dom";
import { GameScreen } from "./ui/gameScreen";
import { hostPanel } from "./ui/hostPanel";

const app = document.getElementById("app")!;
const identity = loadIdentity();

/** Room id from a URL like https://site/#join=abc123... */
function roomFromHash(): string | null {
  const m = /^#join=([a-f0-9]{32,64})$/.exec(location.hash);
  return m ? m[1]! : null;
}

function nameField(): HTMLInputElement {
  return h("input", { type: "text", maxLength: MAX_NAME, placeholder: "Your name", value: identity.name, autofocus: true, required: true });
}

function rememberName(input: HTMLInputElement): string | null {
  const name = input.value.trim();
  if (!name) {
    toast("Please enter a name");
    input.focus();
    return null;
  }
  identity.name = name;
  saveIdentity(identity);
  return name;
}

function screen(...children: Array<Node | string | null>): void {
  setChildren(app, h("div", { class: "card" }, h("h1", {}, "BIRD TACTICS"), h("p", { class: "tagline" }, "A feathery brawl in Mossy Hollow"), ...children));
}

// ---------- Lobby (host) ----------

async function showLobby(): Promise<void> {
  const name = nameField();
  let existing: SaveData | null = null;
  try {
    existing = await loadFromDb();
  } catch (e) {
    toast(`Couldn't read the saved game: ${(e as Error).message}`);
  }
  const savedInfo = existing
    ? h(
        "div",
        { class: "saved" },
        h("p", {}, `Saved game found: turn ${existing.game.turnNumber}, last played ${new Date(existing.savedAt).toLocaleString()}. Hosting resumes it with the same invite link.`),
        h(
          "button",
          {
            class: "small danger",
            onclick: async () => {
              if (!confirm("Delete the saved game and start fresh? (Export it first if you want to keep it.)")) return;
              await clearDb();
              void showLobby();
            },
          },
          "Delete save and start fresh",
        ),
      )
    : null;

  screen(
    h("p", { class: "muted" }, "Shove, peck and screech your rivals into trees. Snack on berries and worms to heal. Last flock standing wins. Host a game and send the invite link to a friend."),
    h(
      "form",
      {
        class: "stack",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (rememberName(name)) startHost(existing ?? newSave(identity, DEFAULT_CONFIG));
        },
      },
      h("label", {}, "Name"),
      name,
      h("button", { class: "primary big", type: "submit" }, existing ? "Host Game (resume)" : "Host Game"),
    ),
    savedInfo,
  );
}

let currentHost: HostSession | null = null;

function startHost(save: SaveData): void {
  currentHost?.stop();
  const me: Identity = { ...identity };
  const host = new HostSession(save, me);
  // Keep the host's seat name in sync with the name typed in the lobby.
  const mySide = sideOf(host.save.game, me.playerId);
  if (mySide) host.save.game.seats[mySide] = { playerId: me.playerId, name: me.name };
  currentHost = host;

  const rematch = () => host.replaceGame(createInitialState(host.state.config, host.state.seats));
  const game = new GameScreen(host, hostPanel(host, (imported) => startHost(imported)), rematch);
  setChildren(app, game.el);
  game.render();
  host.start();
}

// ---------- Join (client) ----------

function showJoin(roomId: string, error?: string): void {
  const name = nameField();
  const pw = h("input", { type: "password", placeholder: "Leave blank if none", autocomplete: "current-password" });
  screen(
    h("p", {}, "You've been invited to a game."),
    error ? h("p", { class: "error" }, error) : null,
    h(
      "form",
      {
        class: "stack",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (rememberName(name)) startClient(roomId, pw.value);
        },
      },
      h("label", {}, "Name"),
      name,
      h("label", {}, "Password (if the host set one)"),
      pw,
      h("button", { class: "primary big", type: "submit" }, "Join Game"),
    ),
    h("p", { class: "muted small" }, h("a", { href: location.pathname }, "Host my own game instead")),
  );
}

function startClient(roomId: string, password: string): void {
  const client = new ClientSession(roomId, { ...identity }, password);
  let game: GameScreen | null = null;

  const update = () => {
    const st = client.status;
    if (st.kind === "failed") {
      game = null;
      if (st.canRetryWithPassword) return showJoin(roomId, st.message);
      return screen(h("p", { class: "error" }, st.message), h("button", { onclick: () => showJoin(roomId) }, "Back"));
    }
    if (client.state) {
      // In game (or temporarily offline mid-game: keep the board, show a banner).
      if (!game) {
        game = new GameScreen(client);
        setChildren(app, game.el);
      }
      game.setBanner(st.kind === "offline" ? st.message : st.kind === "pending" ? st.message : null);
      game.render();
      return;
    }
    const message = st.kind === "connecting" ? "Connecting to the host..." : st.kind === "pending" || st.kind === "offline" ? st.message : "";
    screen(h("div", { class: "spinner" }), h("p", {}, message), h("p", { class: "muted small" }, `Joining as ${identity.name}`));
  };
  client.events.on("change", update);
  client.events.on("toast", (t) => !game && toast(t)); // the game screen shows its own toasts
  update();
  client.start();
}

// ---------- Routing ----------

function route(): void {
  const room = roomFromHash();
  if (room) showJoin(room);
  else void showLobby();
}

window.addEventListener("hashchange", () => {
  if (!currentHost) route();
});
route();
