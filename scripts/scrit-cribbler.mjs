import { MODULE_NAME, startRecapPoller, trackSceneVocab } from "./recorder-api.mjs";
import { RecordingDialog } from "./recording-dialog.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_NAME, "recorder-url", {
    name: "Recorder URL",
    hint: "Where the scrit-recorder service is reached from the browser. The default /scrit is the nginx proxy on the Foundry server; change only if you moved it.",
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    default: "/scrit"
  });

  // Client scope: stored only in this browser, never sent to players.
  game.settings.register(MODULE_NAME, "recorder-token", {
    name: "Recorder token (GM only)",
    hint: "SCRIT_API_TOKEN from the recorder's .env on the Foundry server. Stored only in this browser.",
    scope: "client",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_NAME, "journal-name", {
    name: "Recap journal",
    hint: "Journal entry that recaps are added to. Created (visible to players) if it does not exist.",
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    default: "Session Recaps"
  });
});

// V14 registers scene control buttons via this hook - there is no DOM to
// inject into via renderSceneControls anymore.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  controls.tokens.tools["scrit-cribbler"] = {
    name: "scrit-cribbler",
    title: "Session Recording",
    icon: "fas fa-microphone",
    order: Object.keys(controls.tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => {
      const existing = foundry.applications.instances.get("scrit-cribbler-record");
      if (existing) existing.render({ force: true });
      else new RecordingDialog().render({ force: true });
    }
  };
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  startRecapPoller();
  trackSceneVocab();
});
