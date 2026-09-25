# Scrit Cribbler

Record Foundry VTT game sessions and get AI-written recaps, self-hosted, with no cloud AI and no subscription.

The Foundry **server** records every voice in the LiveKit A/V room (GM and players, one track per person). Each 10-minute chunk is transcribed by Whisper while the session is still running. After you press Stop, a local LLM (Ollama + Mistral) writes the recap. The recap is posted to a journal, and a Markdown copy is saved on the server.

## How it fits together

| Piece | Where | What it does |
|-------|-------|--------------|
| This module | Foundry (GM browser) | Start/Stop panel, progress, posts finished recaps to the journal |
| `scrit-recorder` | Foundry server (Node, PM2) | Joins the LiveKit room as a hidden listener, writes per-speaker audio in 10-min chunks, runs the processing queue, writes the `.md` recap |
| Backend | LAN workstation (Python, Whisper + Ollama) | `/transcribe-chunk`, `/chunk-notes`, `/summarize` over HTTPS with a bearer token |

## Requirements

- Foundry VTT V13+ (verified on V14)
- [LiveKit AVClient](https://github.com/bekriebel/fvtt-module-avclient-livekit) for A/V; the recorder joins the same LiveKit room
- `scrit-recorder` service on the Foundry server, reachable at `/scrit` through the reverse proxy
- The backend running on a machine the server can reach

## Setup

1. Enable the module in your world.
2. As GM: **Configure Settings → Scrit Cribbler → Recorder token**, and paste `SCRIT_API_TOKEN` from the recorder's `.env`. The token is stored only in that browser.
3. Optional: change **Recap journal** (default `Session Recaps`).

## Usage

1. Everyone joins A/V as usual.
2. GM: microphone icon in the Token controls → name the session → **Start recording**. You can close the panel or reload the page; the recording keeps running on the server.
3. **Stop recording** at the end of the session.
4. When processing finishes, the active GM's client posts two pages to the recap journal:
   - **Session name — date**: the recap (Summary, Key Events, People & Places, Loot & Rewards, Open Threads). Players can read it.
   - **Session name — date (Transcript)**: the full transcript, labeled "Character (Player)". GM only.

   If no GM is online when processing finishes, the recap is posted the next time a GM logs in.
5. **Reprocess** re-runs transcription and summary for a saved session, for example after a backend fix.

## Files on the server

- `Data/scrit-cribbler/recordings/<world>/<date_time>-<session>/chunk-NNN/`: per-speaker `.ogg`, `mixed.ogg`, `transcript.json`, `notes.md`
- `Data/scrit-cribbler/recaps/<world>-<date>-<session>.md`: recap plus transcript

Foundry serves the whole `Data/` folder publicly, so the reverse proxy must block `/scrit-cribbler/`.

## Known limitations

- Whisper `base` on CPU mis-hears names. The transcript keeps the misheard versions, and the recap may repeat them.
- Speakers are labeled from their Foundry user and assigned character. Two people on one microphone share a label.
