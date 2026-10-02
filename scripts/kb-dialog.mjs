import { MODULE_NAME, askKb } from "./recorder-api.mjs";
import { errorMessage, historyEntry } from "./kb-format.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const HISTORY_MAX = 10;

/**
 * GM-only lore lookups: "Ask the campaign KB". The question goes to the recorder (/scrit/kb/ask), which checks
 * that you are logged in to Foundry as the Gamemaster, then to the knowledge base on the workstation.
 * Answers stay on this screen: nothing is posted to chat or a journal, and nothing is saved in the browser.
 */
export class KbDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "scrit-cribbler-kb",
    tag: "div",
    window: { title: "Scrit Cribbler — Ask the campaign KB", resizable: true },
    position: { width: 560, height: 640 },
    classes: ["scrit-cribbler", "scrit-cribbler-dialog", "scrit-cribbler-kb"],
    actions: {
      ask: KbDialog.#onAsk,
      clear: KbDialog.#onClear
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_NAME}/templates/kb.hbs` }
  };

  question = "";
  audience = "gm";
  busy = false;
  error = null;
  history = [];
  #clock = null;

  /** Open (or focus) the dialog. The server enforces GM-only too; this just avoids a pointless window. */
  static open() {
    if (!game.user.isGM) return ui.notifications.warn("Only the Gamemaster can ask the campaign KB.");
    const existing = foundry.applications.instances.get(KbDialog.DEFAULT_OPTIONS.id);
    return (existing ?? new KbDialog()).render({ force: true });
  }

  async _prepareContext() {
    return {
      tokenMissing: !game.settings.get(MODULE_NAME, "recorder-token"),
      question: this.question,
      isGm: this.audience === "gm",
      busy: this.busy,
      error: this.error,
      history: this.history
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const box = this.element.querySelector("textarea[name='kb-question']");
    box?.addEventListener("input", (ev) => (this.question = ev.currentTarget.value));
    // Enter asks; Shift+Enter adds a line.
    box?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.#ask();
      }
    });
    this.element.querySelector("select[name='kb-audience']")?.addEventListener("change", (ev) => (this.audience = ev.currentTarget.value));
    if (!this.busy) box?.focus();
  }

  async _onClose(options) {
    clearInterval(this.#clock);
    return super._onClose(options);
  }

  static async #onAsk() {
    await this.#ask();
  }

  static async #onClear() {
    this.history = [];
    await this.render({ parts: ["form"] });
  }

  async #ask() {
    const question = this.question.trim();
    if (this.busy || !question) return;
    this.busy = true;
    this.error = null;
    await this.render({ parts: ["form"] });
    const t0 = Date.now();
    this.#clock = setInterval(() => {
      const el = this.element?.querySelector("[data-kb-elapsed]");
      if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
    }, 1000);
    try {
      const response = await askKb(question, this.audience);
      this.history = [historyEntry({ question, audience: this.audience, response }), ...this.history].slice(0, HISTORY_MAX);
      this.question = "";
    } catch (e) {
      this.error = errorMessage(e.status, e.message);
    } finally {
      clearInterval(this.#clock);
      this.busy = false;
      if (this.rendered) await this.render({ parts: ["form"] });
    }
  }
}
