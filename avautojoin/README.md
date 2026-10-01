# A/V Auto-Join (`avautojoin`)

Optional companion module for [LiveKit AVClient](https://github.com/bekriebel/fvtt-module-avclient-livekit), packaged with Scrit Cribbler. It was built for players who are not technical.

- Players join voice with no settings and no confirmation dialog. A/V opens in a separate browser tab with the **mic on and the camera off** (the camera can be turned on in the tab).
- The LiveKit API secret never reaches player browsers. Tokens are issued by `scrit-recorder`.

Foundry V13+ (verified on V14). Needs `avclient-livekit` and the `scrit-recorder` service from this repo.

## How it works

- **Separate tab, no dialog.** For non-GM users the module turns on avclient-livekit's *Use separate window for A/V* setting (world setting **Force separate A/V tab for players**, on by default), then opens the tab itself. If the browser blocks the pop-up, the player gets one **Join voice chat** button instead.
- **Own join page.** LiveKit's hosted web client always turns the camera on, so `join.html` is used instead. Foundry serves `.html` files under `Data/` as plain text on purpose, so the module fetches the page and writes it into a blank same-origin tab rather than navigating to it. The page uses a bundled copy of [livekit-client](https://github.com/livekit/client-sdk-js) (Apache-2.0, `vendor/`).
- **Reloading Foundry keeps the call.** The tab is reused; if it is already in the same room it is left alone. An A/V breakout room switches the tab to the new room.
- **Secure tokens.** The module adds a LiveKit server type, **Foundry server (secure)**. Its tokens come from `POST /scrit/livekit/token` on `scrit-recorder`, which finds out who is asking by opening a short socket to Foundry with the caller's session cookie. Identity and `fvttUserId` in the token come from that verified user. The LiveKit API key and secret stay in the recorder's `.env`.

## Install

1. Run `scrit-recorder` and the reverse proxy route `/scrit/` as described in the main README. The recorder's `.env` needs `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. If Foundry is not on `http://127.0.0.1:30000` or the public origin is not `https://<Host header>`, also set `FOUNDRY_URL` / `FOUNDRY_ORIGIN`.
2. Set `LIVEKIT_HOST` near the top of `avautojoin.js` to your LiveKit server host (no `wss://`, for example `my-project.livekit.cloud`). It must match the host in the recorder's `LIVEKIT_URL`. It is fixed in the module on purpose: the A/V settings form cannot blank it. The file ships with the placeholder `your-project.livekit.cloud`; while it is still there the GM gets a permanent error notice when Foundry loads. Tip: have your deploy script copy the folder and replace only the `const LIVEKIT_HOST = "...";` line with the host from `LIVEKIT_URL`, so the host lives in one place (leave the `HOST_IS_PLACEHOLDER` line alone, it is the check).
3. Copy this folder to `Data/modules/avautojoin/`, for example `rsync -a --delete avautojoin/ <Data>/modules/avautojoin/`. Do not put a git checkout of the repo under `Data/`: Foundry serves `Data/` publicly, `.git` included.
4. Enable **A/V Auto-Join** in the world.
5. As GM: **Configure Settings → Audio/Video Configuration → LiveKit AVClient**, set LiveKit Server to **Foundry server (secure)**, save, and have everyone reload.

## Players, once per browser

- Allow pop-ups for the Foundry site (until then they get the **Join voice chat** button).
- Allow the microphone ("remember").

## Rotating the LiveKit key

Create the new key in LiveKit Cloud, put it in the recorder `.env`, restart `scrit-recorder`, then delete the old key. Nothing needs to change in Foundry's world settings.
