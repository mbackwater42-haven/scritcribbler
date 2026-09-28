import { MODULE_NAME, api, campaignVocab, currentRoom, roster, postRecap, storySoFar } from "./recorder-api.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const REFRESH_MS = 5000;

/** Public chat line, so every player knows when the table is recorded. */
async function announce(content) {
  await ChatMessage.create({ content, style: CONST.CHAT_MESSAGE_STYLES.OOC, speaker: { alias: "Scrit Cribbler" } });
}

async function retentionNote() {
  try {
    const { retentionDays } = await api("/storage");
    return retentionDays ? ` Audio is deleted ${retentionDays} days after the recap is posted.` : "";
  } catch {
    return "";
  }
}
const STATE_LABELS = {
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  error: "Failed"
};

/**
 * GM control panel. Recording happens on the Foundry server (scrit-recorder joins the
 * LiveKit room), so this dialog only starts/stops it and shows progress. Closing it,
 * reloading, or even a browser crash does not affect the recording.
 */
export class RecordingDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "scrit-cribbler-record",
    tag: "div",
    window: { title: "Scrit Cribbler — Session Recording", resizable: true },
    position: { width: 520, height: "auto" },
    classes: ["scrit-cribbler", "scrit-cribbler-dialog"],
    actions: {
      start: RecordingDialog.#onStart,
      stop: RecordingDialog.#onStop,
      post: RecordingDialog.#onPost,
      reprocess: RecordingDialog.#onReprocess,
      dismiss: RecordingDialog.#onDismiss,
      dismissAll: RecordingDialog.#onDismissAll,
      keep: RecordingDialog.#onKeep,
      delete: RecordingDialog.#onDelete
    }
  };

  static PARTS = {
    controls: { template: `modules/${MODULE_NAME}/templates/controls.hbs` },
    sessions: { template: `modules/${MODULE_NAME}/templates/sessions.hbs` }
  };

  sessionName = "";
  status = { active: null, sessions: [], error: null };
  busy = false;
  #refreshTimer = null;
  #clockTimer = null;

  async _prepareContext() {
    const s = this.status;
    const active = s.sessions.find((x) => x.id === s.active) ?? null;
    return {
      tokenMissing: !game.settings.get(MODULE_NAME, "recorder-token"),
      room: currentRoom(),
      error: s.error,
      busy: this.busy,
      sessionName: this.sessionName,
      defaultName: "Session",
      active: active && this.#view(active),
      recent: s.sessions.filter((x) => x.id !== s.active && !x.dismissed).slice(0, 6).map((x) => this.#view(x))
    };
  }

  #view(s) {
    const total = s.chunks.length;
    const transcribed = s.chunks.filter((c) => c.status === "transcribed").length;
    const failed = s.chunks.filter((c) => c.status === "error").length;
    let progress = "";
    if (s.state === "recording") progress = `Chunk ${total} in progress · ${transcribed} transcribed so far`;
    else if (s.state === "processing") progress = `Transcribed ${transcribed}/${total} chunks${transcribed === total ? " · writing recap" : ""}`;
    if (failed) progress += ` · ${failed} chunk(s) failed`;
    return {
      ...s,
      stateLabel: STATE_LABELS[s.state] ?? s.state,
      stateClass: `state-${s.state}`,
      started: new Date(s.startedAt).toLocaleString(),
      minutes: Math.round(s.durationSec / 60),
      progress,
      speakerList: s.speakers.join(", "),
      recapLabel: { "no-story": "No story recap (too little story content)", unverified: "AI recap withheld: mentioned things never said" }[s.recapStatus] ?? "",
      canPost: s.state === "done" && !s.posted,
      canReprocess: ["done", "error"].includes(s.state) && !s.audioDeletedAt,
      canDismiss: ["done", "error"].includes(s.state),
      finished: ["done", "error"].includes(s.state),
      audioLabel: s.audioDeletedAt
        ? `Audio deleted ${new Date(s.audioDeletedAt).toLocaleDateString()} (transcript and recap kept)`
        : s.keepAudio ? "Audio kept (never deleted automatically)"
          : s.audioExpiresAt ? `Audio kept until ${new Date(s.audioExpiresAt).toLocaleDateString()}` : ""
    };
  }

  async refresh({ all = false } = {}) {
    const before = this.status.active;
    try {
      const data = await api(`/sessions?world=${encodeURIComponent(game.world.id)}`);
      this.status = { active: data.active && data.sessions.some((x) => x.id === data.active) ? data.active : null, sessions: data.sessions, error: null };
    } catch (e) {
      this.status = { ...this.status, error: e.message };
    }
    if (!this.rendered) return;
    // Only redraw the controls (and the name field) when recording starts or stops.
    const parts = all || before !== this.status.active ? ["controls", "sessions"] : ["sessions"];
    await this.render({ parts });
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    this.#clockTimer = setInterval(() => this.#tickClock(), 1000);
    this.refresh({ all: true });
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const input = this.element.querySelector("input[name='session-name']");
    input?.addEventListener("input", (ev) => (this.sessionName = ev.currentTarget.value));
    this.#tickClock();
  }

  async _onClose(options) {
    clearInterval(this.#refreshTimer);
    clearInterval(this.#clockTimer);
    return super._onClose(options);
  }

  #tickClock() {
    const el = this.element?.querySelector("[data-started-at]");
    if (!el) return;
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.startedAt)) / 1000));
    const hh = Math.floor(secs / 3600);
    const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    el.textContent = `${hh}:${mm}:${ss}`;
  }

  async #withBusy(fn) {
    this.busy = true;
    await this.render({ parts: ["controls"] });
    try {
      await fn();
    } catch (e) {
      ui.notifications.error(`Scrit Cribbler | ${e.message}`);
    } finally {
      this.busy = false;
      await this.refresh({ all: true });
    }
  }

  static async #onStart() {
    const room = currentRoom();
    if (!room) {
      ui.notifications.error("Scrit Cribbler | No A/V room found. Is LiveKit AVClient connected?");
      return;
    }
    const sessionName = this.sessionName.trim() || "Session";
    await this.#withBusy(async () => {
      await api("/sessions/start", {
        method: "POST",
        body: {
          world: game.world.id,
          worldTitle: game.world.title,
          room,
          sessionName,
          roster: roster(),
          vocab: campaignVocab(),
          storySoFar: storySoFar(),
          usePreviousRecap: game.settings.get(MODULE_NAME, "use-previous-recap")
        }
      });
      this.sessionName = "";
      ui.notifications.info(`Scrit Cribbler | Recording "${sessionName}" on the server.`);
      await announce(`<p><strong>🔴 This session is being recorded.</strong> Voices in the A/V chat are transcribed to write the session recap.${await retentionNote()}</p>`);
    });
  }

  static async #onStop() {
    const id = this.status.active;
    if (!id) return;
    const ok = await DialogV2.confirm({
      window: { title: "Stop recording?" },
      content: "<p>Stop recording and start writing the recap? This cannot be resumed.</p>"
    });
    if (!ok) return;
    await this.#withBusy(async () => {
      await api(`/sessions/${id}/stop`, { method: "POST" });
      await announce("<p><strong>⏹ Recording stopped.</strong></p>");
      ui.notifications.info("Scrit Cribbler | Recording stopped. The recap will be posted to the journal when it is ready.");
    });
  }

  static async #onPost(_event, target) {
    await this.#withBusy(() => postRecap(target.dataset.sessionId));
  }

  static async #onDismiss(_event, target) {
    await this.#withBusy(() => api(`/sessions/${target.dataset.sessionId}/dismiss`, { method: "POST" }));
  }

  static async #onDismissAll() {
    const ok = await DialogV2.confirm({
      window: { title: "Clear recent sessions?" },
      content: "<p>Remove all finished sessions from this list? Recordings, recap files and journal pages are kept.</p>"
    });
    if (!ok) return;
    await this.#withBusy(() => api("/sessions/dismiss-all", { method: "POST", body: { world: game.world.id } }));
  }

  static async #onKeep(_event, target) {
    const s = this.status.sessions.find((x) => x.id === target.dataset.sessionId);
    if (!s) return;
    await this.#withBusy(() => api(`/sessions/${s.id}/keep`, { method: "POST", body: { keep: !s.keepAudio } }));
  }

  static async #onDelete(_event, target) {
    const s = this.status.sessions.find((x) => x.id === target.dataset.sessionId);
    if (!s) return;
    const esc = foundry.utils.escapeHTML;
    const people = Object.entries(s.people ?? {});
    const content = `<p>What should be deleted from <strong>${esc(s.sessionName)}</strong>?</p>
      <label class="sc-choice"><input type="radio" name="scope" value="session" checked> <strong>The whole session:</strong> audio, transcripts and the recap file on the server.</label>
      ${s.audioDeletedAt ? "" : `<label class="sc-choice"><input type="radio" name="scope" value="audio"> <strong>Audio only:</strong> keep the transcript and recap. It can no longer be reprocessed.</label>`}
      ${s.audioDeletedAt || !people.length ? "" : `<label class="sc-choice"><input type="radio" name="scope" value="speaker"> <strong>One person:</strong> remove their audio and lines, then rewrite the recap without them.</label>
      <select name="identity">${people.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join("")}</select>`}
      <p class="sc-sub">Journal pages already posted are not changed; delete or edit those in the journal. This cannot be undone.</p>`;
    const choice = await DialogV2.prompt({
      window: { title: "Delete recording" },
      content,
      ok: {
        label: "Delete",
        icon: "fas fa-trash",
        callback: (_ev, button) => ({ scope: button.form.elements.scope.value, identity: button.form.elements.identity?.value })
      },
      rejectClose: false
    });
    if (!choice) return;
    await this.#withBusy(async () => {
      const res = await api(`/sessions/${s.id}/delete`, { method: "POST", body: choice });
      if (res.deleted === "speaker") {
        await api(`/sessions/${s.id}/reprocess`, {
          method: "POST",
          body: { vocab: campaignVocab(), storySoFar: storySoFar(), usePreviousRecap: game.settings.get(MODULE_NAME, "use-previous-recap") }
        });
        ui.notifications.info(`Scrit Cribbler | Removed ${res.label}. Rewriting the recap without them; delete the old journal pages yourself.`);
      } else {
        ui.notifications.info(`Scrit Cribbler | Deleted (${res.deleted}).`);
      }
    });
  }

  static async #onReprocess(_event, target) {
    const ok = await DialogV2.confirm({
      window: { title: "Reprocess recording?" },
      content: "<p>Transcribe and summarize this recording again? A new recap page is added to the journal when it finishes.</p>"
    });
    if (!ok) return;
    // Fresh vocabulary: older sessions have none, and the party's gear may have changed.
    await this.#withBusy(() => api(`/sessions/${target.dataset.sessionId}/reprocess`, {
      method: "POST",
      body: { vocab: campaignVocab(), storySoFar: storySoFar(), usePreviousRecap: game.settings.get(MODULE_NAME, "use-previous-recap") }
    }));
  }
}
