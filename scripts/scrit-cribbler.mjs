import { RecordingDialog } from "./recording-dialog.mjs";

const MODULE_NAME = "scrit-cribbler";

class ScritCribblerApp {
  static async initialize() {
    game.settings.register(MODULE_NAME, "backend-url", {
      name: "Backend URL",
      hint: "HTTP endpoint for transcription service (e.g., http://192.168.0.27:5000)",
      scope: "world",
      config: true,
      type: String,
      default: "http://localhost:5000"
    });

    game.settings.register(MODULE_NAME, "auto-journal", {
      name: "Auto-create journal entries",
      hint: "Automatically create journal entry for summary (requires GM)",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    console.log("Scrit Cribbler | Module initialized");
  }

  static async testBackend() {
    const backendUrl = game.settings.get(MODULE_NAME, "backend-url");
    try {
      const response = await fetch(`${backendUrl}/health`);
      const data = await response.json();
      return data.status === "ok";
    } catch (e) {
      console.error("Scrit Cribbler | Backend unreachable:", e);
      return false;
    }
  }
}

// V14 registers scene control buttons via this hook - there is no DOM to
// inject into via renderSceneControls anymore.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  controls.tokens.tools["scrit-cribbler"] = {
    name: "scrit-cribbler",
    title: "Record Session",
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
  ScritCribblerApp.initialize();
});

export { ScritCribblerApp };
