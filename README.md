# Scrit Cribbler

Record Foundry VTT game sessions and get AI-generated summaries — self-hosted, no cloud, no subscription.

## Requirements

- Foundry VTT V13+ (verified on V14)
- D&D 5e system (currently the only listed relationship; the module has no system-specific logic and likely works fine elsewhere)
- The [Scrit Cribbler backend service](https://github.com/mbackwater42-haven/scritcribbler) running somewhere on your LAN (Whisper transcription + Ollama/Mistral summarization)

## Install

In Foundry's Add-on Modules tab, install via manifest URL:

```
https://raw.githubusercontent.com/mbackwater42-haven/scritcribbler/main/module.json
```

## Setup

1. Enable the module in your world
2. Go to Module Settings → Scrit Cribbler → set **Backend URL** to wherever the backend is running (e.g. `http://192.168.0.27:5000`)
3. As GM, a microphone icon appears in the Token controls toolbar

## Usage

1. Click the microphone icon → **Start Recording** at the start of your session
2. **Stop Recording** when done — saves a compressed `.webm` locally to `Data/scrit-cribbler/recordings/`
3. Click **Process & Summarize** whenever you're ready (no need to do it right away) — sends the recording to your backend
4. Summary + transcript land in a GM chat whisper and get appended to a **Session Recaps** journal entry (auto-created on first use)

## Known limitations

- No incremental persistence during recording — if the browser tab crashes mid-session before you hit Stop, the recording is lost. Process recordings promptly.
- Very quiet/noisy audio degrades transcription quality (Whisper base model).
- No speaker diarization — transcript is a single undifferentiated stream.
