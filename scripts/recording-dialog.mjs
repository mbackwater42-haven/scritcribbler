const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_NAME = "scrit-cribbler";
const RECORDINGS_FOLDER = "scrit-cribbler/recordings";
const RECORDING_TIMESLICE_MS = 60000; // flush chunk every 60s (long-session safety)

export class RecordingDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "scrit-cribbler-record",
    tag: "form",
    window: {
      title: "Record Game Session",
      resizable: true
    },
    position: { width: 600, height: "auto" },
    classes: ["scrit-cribbler", "scrit-cribbler-dialog"]
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_NAME}/templates/record-dialog.hbs`
    }
  };

  mediaRecorder = null;
  audioChunks = [];
  isRecording = false;
  recordingStart = null;
  recordingBlob = null; // kept in memory; also mirrored to disk for archival
  timerInterval = null;

  async _prepareContext(options) {
    return {
      isRecording: this.isRecording,
      recordingTime: this.getRecordingTime(),
      hasSavedRecording: !!this.recordingBlob
    };
  }

  getRecordingTime() {
    if (!this.recordingStart) return "00:00";
    const elapsed = Math.floor((Date.now() - this.recordingStart) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    html.querySelector("[data-action='start-recording']")
      ?.addEventListener("click", () => this.startRecording());

    html.querySelector("[data-action='stop-recording']")
      ?.addEventListener("click", () => this.stopRecording());

    html.querySelector("[data-action='process-recording']")
      ?.addEventListener("click", () => this.processRecording());

    if (this.isRecording) {
      this.timerInterval = setInterval(() => {
        const el = html.querySelector(".recording-time");
        if (el) el.textContent = this.getRecordingTime();
      }, 1000);
    }
  }

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        throw new Error("Browser does not support WebM Opus codec");
      }

      this.mediaRecorder = new MediaRecorder(stream, { mimeType });
      this.audioChunks = [];
      this.recordingStart = Date.now();
      this.isRecording = true;

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.audioChunks.push(event.data);
      };

      // timeslice flushes chunks periodically instead of only on stop()
      this.mediaRecorder.start(RECORDING_TIMESLICE_MS);
      this.render();
      ui.notifications.info("Recording started...");
    } catch (e) {
      console.error("Scrit Cribbler | Microphone error:", e);
      ui.notifications.error("Failed to access microphone. Check permissions.");
    }
  }

  async stopRecording() {
    if (!this.mediaRecorder) return;

    const stopped = new Promise((resolve) => {
      this.mediaRecorder.addEventListener("stop", resolve, { once: true });
    });

    this.mediaRecorder.stop();
    this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    await stopped;

    this.isRecording = false;
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.recordingBlob = new Blob(this.audioChunks, { type: "audio/webm" });
    const duration = Math.floor((Date.now() - this.recordingStart) / 1000);

    const sessionNameInput = this.element.querySelector("[name='session-name']");
    const sessionName = sessionNameInput?.value || "Session";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${sessionName.replace(/[^\w\-]/g, "_")}-${timestamp}.webm`;

    ui.notifications.info(`Recording complete (${Math.round(duration / 60)} min). Saving local copy...`);

    try {
      // Ensure recordings folder exists (createDirectory throws if it already exists - safe to ignore)
      await FilePicker.createDirectory("data", RECORDINGS_FOLDER).catch(() => null);

      const file = new File([this.recordingBlob], filename, { type: "audio/webm" });
      await FilePicker.upload("data", RECORDINGS_FOLDER, file, {}, { notify: false });

      console.log("Scrit Cribbler | Saved recording to", `${RECORDINGS_FOLDER}/${filename}`);
      ui.notifications.info(`Recording saved: ${filename}`);
      this.render();
    } catch (e) {
      // Local archival save failed, but the Blob is still in memory - processing can still proceed
      console.error("Scrit Cribbler | Local save failed (recording still in memory):", e);
      ui.notifications.warn(`Local save failed, but recording is still available to process: ${e.message}`);
      this.render();
    }
  }

  async processRecording() {
    if (!this.recordingBlob) {
      ui.notifications.warn("No recording to process");
      return;
    }

    const sessionNameInput = this.element.querySelector("[name='session-name']");
    const sessionName = sessionNameInput?.value || "Game Session";
    const audioBlob = this.recordingBlob;

    ui.notifications.info("Processing recording in the background... (may take 10+ minutes for long sessions). You'll get a chat message when it's done.");

    // Close immediately - this is a long background job, no reason to make the
    // GM sit and watch the dialog. Everything from here on runs detached.
    this.close();

    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "session.webm");
      formData.append("session_name", sessionName);

      const backendUrl = game.settings.get(MODULE_NAME, "backend-url");
      const response = await fetch(`${backendUrl}/transcribe`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      if (result.status !== "success") {
        throw new Error(result.error || "Unknown error");
      }

      await this.addToRecapsJournal(result, sessionName);
      await this.displayResults(result);

      ui.notifications.info("Transcription complete! Summary added to Session Recaps.");
    } catch (e) {
      console.error("Scrit Cribbler | Process error:", e);
      ui.notifications.error(`Processing failed: ${e.message}`);
    }
  }

  async displayResults(result) {
    const durationMin = Math.round(result.duration_seconds / 60);
    const message = `
      <div class="scrit-cribbler-results">
        <h3>✓ Session Summary Processed</h3>
        <p><strong>Duration:</strong> ${durationMin} minutes | <strong>Timestamp:</strong> ${new Date(result.timestamp).toLocaleString()}</p>
        <hr />
        <h4>Summary:</h4>
        <p>${result.summary.split("\n").join("<br />")}</p>
        <details>
          <summary>Full Transcript (${result.transcript.length} chars)</summary>
          <div style="max-height: 400px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: break-word; font-size: 0.9em;">${result.transcript}</div>
        </details>
        <p style="font-size: 0.9em; color: #999; margin-top: 1rem;">Summary saved to "Session Recaps" journal entry.</p>
      </div>
    `;

    // V14 uses "style", not the removed "type"/CONST.CHAT_MESSAGE_TYPES
    await ChatMessage.create({
      content: message,
      whisper: ChatMessage.getWhisperRecipients("GM"),
      style: CONST.CHAT_MESSAGE_STYLES.OOC,
      speaker: { alias: "Scrit Cribbler" }
    });
  }

  async addToRecapsJournal(result, sessionName) {
    let recapsEntry = game.journal.getName("Session Recaps");

    if (!recapsEntry) {
      recapsEntry = await JournalEntry.create({
        name: "Session Recaps",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
      });
      console.log("Scrit Cribbler | Created Session Recaps journal");
    }

    const pageDate = new Date(result.timestamp);
    const durationMin = Math.round(result.duration_seconds / 60);
    const pageTitle = `${sessionName} — ${pageDate.toLocaleDateString()} (${durationMin} min)`;

    await JournalEntryPage.create(
      {
        name: pageTitle,
        type: "text",
        text: {
          content: `
            <h2>${pageTitle}</h2>
            <p><strong>Date:</strong> ${pageDate.toLocaleString()} | <strong>Duration:</strong> ${durationMin} minutes</p>
            <hr />
            <h3>Summary</h3>
            <p>${result.summary.split("\n").join("<br /><br />")}</p>
            <details>
              <summary>Full Transcript</summary>
              <div style="background: var(--color-bg); padding: 1rem; border-radius: 4px; max-height: 500px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: break-word;">${result.transcript}</div>
            </details>
          `
        }
      },
      { parent: recapsEntry }
    );

    console.log("Scrit Cribbler | Added page to Session Recaps:", pageTitle);
  }
}
