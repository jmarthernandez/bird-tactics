// Host-only settings: invite link, password, join requests, approved players,
// kick, saves, config, and regenerating the link.

import { validateConfig } from "../game/config";
import { createInitialState } from "../game/rules";
import type { GameConfig } from "../game/types";
import type { HostSession } from "../net/host";
import { downloadJson, migrate, pickJsonFile, pickSaveFile, supportsFileLink, writeSaveFile, type SaveData } from "../storage/save";
import { h, setChildren, toast } from "./dom";

export function hostPanel(host: HostSession, onImportSave: (save: SaveData) => void): HTMLElement {
  const status = h("div", { class: "status" });
  const linkInput = h("input", { type: "text", readOnly: true, class: "link" });
  const requests = h("div", { class: "requests" });
  const approved = h("ul", { class: "approved" });
  const fileStatus = h("span", { class: "muted small" });
  const pwInput = h("input", { type: "password", placeholder: "No password", autocomplete: "new-password" });
  pwInput.value = host.save.password;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(host.inviteLink);
      toast("Invite link copied");
    } catch {
      linkInput.select();
      toast("Press Ctrl/Cmd+C to copy");
    }
  };

  const linkFileBtn = supportsFileLink()
    ? h(
        "button",
        {
          onclick: async () => {
            try {
              host.fileHandle = await pickSaveFile();
              await writeSaveFile(host.fileHandle, host.save);
              toast(`Autosaving to ${host.fileHandle.name}`);
              render();
            } catch (e) {
              if ((e as Error).name !== "AbortError") toast(`Couldn't link file: ${String(e)}`);
            }
          },
        },
        "Link save file on disk",
      )
    : null; // Safari/Firefox: no File System Access API, so hide the button

  const replaceWithConfig = (config: GameConfig) => {
    host.replaceGame(createInitialState(config, host.state.seats));
    toast("New game started");
  };

  const el = h(
    "details",
    { class: "hostpanel", open: true },
    h("summary", {}, "Host settings"),
    status,
    h("label", {}, "Invite link"),
    h("div", { class: "row" }, linkInput, h("button", { class: "primary", onclick: copyLink }, "Copy")),
    h("p", { class: "muted small" }, "Send this to your friend. Anyone with the link can ask to join; you approve them."),
    requests,
    h("label", {}, "Password (optional)"),
    h(
      "div",
      { class: "row" },
      pwInput,
      h("button", { onclick: () => (host.setPassword(pwInput.value), toast(pwInput.value ? "Password set" : "Password removed")) }, "Save"),
    ),
    h("label", {}, "Approved players"),
    approved,
    h("label", {}, "Saves"),
    h(
      "div",
      { class: "row wrap" },
      h("button", { onclick: () => downloadJson(host.save, `bird-tactics-save-turn${host.state.turnNumber}.json`) }, "Export Save"),
      h(
        "button",
        {
          onclick: async () => {
            try {
              const save = migrate(await pickJsonFile());
              if (confirm("Replace the current game with this save? (Its invite link will be used.)")) onImportSave(save);
            } catch (e) {
              toast(`Import failed: ${(e as Error).message}`);
            }
          },
        },
        "Import Save",
      ),
      linkFileBtn,
    ),
    fileStatus,
    h("label", {}, "Game config"),
    h(
      "div",
      { class: "row wrap" },
      h(
        "button",
        {
          onclick: async () => {
            try {
              const config = await pickJsonFile();
              const errors = validateConfig(config);
              if (errors.length) return void alert("That config has problems:\n\n" + errors.join("\n"));
              if (confirm("Loading a config starts a new game on the new board. Continue?")) replaceWithConfig(config as GameConfig);
            } catch (e) {
              toast((e as Error).message);
            }
          },
        },
        "Load Config",
      ),
      h("button", { onclick: () => downloadJson(host.state.config, "bird-tactics-config.json") }, "Download Current Config"),
      h("button", { onclick: () => confirm("Restart from turn 1 with the same players?") && replaceWithConfig(host.state.config) }, "New Game"),
    ),
    h("label", {}, "Danger zone"),
    h(
      "button",
      {
        class: "danger",
        onclick: () => {
          if (!confirm("Make a new invite link? The old link stops working and connected players are dropped (approved players stay approved).")) return;
          host.regenerateLink();
          render();
          toast("New invite link created");
        },
      },
      "Regenerate invite link",
    ),
  );

  function render(): void {
    status.className = `status ${host.online ? "ok" : "warn"}`;
    status.textContent = host.status;
    linkInput.value = host.inviteLink;
    fileStatus.textContent = host.fileHandle ? `Autosaving to file: ${host.fileHandle.name} (also autosaves in this browser)` : "Autosaves in this browser after every move.";

    setChildren(
      requests,
      ...host.joinRequests.map((r) =>
        h(
          "div",
          { class: "request" },
          h("b", {}, r.name), " wants to join",
          h("button", { class: "primary", onclick: () => host.approve(r.connId) }, "Allow"),
          h("button", { class: "danger", onclick: () => host.deny(r.connId) }, "Deny"),
        ),
      ),
    );

    const online = host.connectedIds;
    setChildren(
      approved,
      ...(host.save.approvedPlayers.length === 0 ? [h("li", { class: "muted" }, "Nobody yet")] : []),
      ...host.save.approvedPlayers.map((p) =>
        h(
          "li",
          {},
          h("span", { class: online.has(p.playerId) ? "online" : "offline" }, "●"),
          ` ${p.name} `,
          online.has(p.playerId) ? h("span", { class: "muted small" }, "(online)") : null,
          h(
            "button",
            { class: "small danger", onclick: () => confirm(`Remove ${p.name}? They'll be disconnected and need approval to rejoin.`) && host.kick(p.playerId) },
            online.has(p.playerId) ? "Kick" : "Remove",
          ),
        ),
      ),
    );
  }

  host.events.on("change", render);
  render();
  return el;
}
