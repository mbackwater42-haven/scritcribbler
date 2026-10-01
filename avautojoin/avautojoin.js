/**
 * A/V Auto-Join
 * - Forces LiveKit AVClient's "Use separate window for A/V" on for players.
 * - Replaces the "Join A/V with LiveKit web client?" dialog with a direct tab open.
 * - Opens our own join page (mic on, camera off) instead of meet.livekit.io,
 *   which always turns the camera on.
 * - If the browser blocks the pop-up, falls back to one big "Join voice chat" button.
 * - Adds the "Foundry server (secure)" LiveKit server type (tokens minted server-side).
 */

const MODULE_ID = "avautojoin";
const LIVEKIT_ID = "avclient-livekit";
const WINDOW_NAME = "foundry-av";
// LiveKit host for the "Foundry server (secure)" type, without "wss://". Fixed here so clearing fields
// in the A/V settings form can't break voice. Must match the host in LIVEKIT_URL in the scrit-recorder
// .env. The placeholder below is replaced with your real host when you deploy (see README).
const LIVEKIT_HOST = "your-project.livekit.cloud";
const HOST_IS_PLACEHOLDER = LIVEKIT_HOST === "your-project.livekit.cloud";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "forcePlayers", {
    name: "Force separate A/V tab for players",
    hint: "Players (non-GM) always use the separate A/V tab and join automatically. GMs keep their own choice.",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: true }),
    requiresReload: true
  });
});

// "setup" runs right before Game#initializeRTC constructs the AV client.
Hooks.once("setup", () => {
  if (!game.modules.get(LIVEKIT_ID)?.active) return;
  if (game.settings.get(MODULE_ID, "forcePlayers") && !game.user.isGM) {
    if (!game.settings.get(LIVEKIT_ID, "useExternalAV")) {
      game.settings.set(LIVEKIT_ID, "useExternalAV", true);
    }
  }

  const BaseClient = CONFIG.WebRTC.clientClass;
  CONFIG.WebRTC.clientClass = class AutoJoinAVClient extends BaseClient {
    constructor(...args) {
      super(...args);
      if (this._liveKitClient) this._liveKitClient.sendJoinMessage = sendJoinMessage;
    }
  };
});

// LiveKit server type whose tokens come from the scrit-recorder service on this server
// (POST /scrit/livekit/token, authenticated by the Foundry session cookie). Keeps the
// LiveKit API secret off player machines. Pick it in Audio/Video Configuration → LiveKit AVClient.
Hooks.on("liveKitClientAvailable", (liveKitClient) => {
  liveKitClient.addLiveKitServerType({
    key: "foundryserver",
    label: "Foundry server (secure)",
    details: `Tokens are issued by this Foundry server; the API key and secret stay on the server. LiveKit server: ${LIVEKIT_HOST}`,
    url: LIVEKIT_HOST,
    urlRequired: false,
    usernameRequired: false,
    passwordRequired: false,
    tokenFunction: serverToken
  });
});

/** tokenFunction(apiKey, secret, room, userName, metadataJson) → JWT, or "" on failure. */
async function serverToken(_key, _secret, room, userName, metadata) {
  let useExternalAV = false;
  try { useExternalAV = JSON.parse(metadata || "{}").useExternalAV === true; } catch { /* default */ }
  try {
    const res = await fetch("/scrit/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, name: userName, useExternalAV })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(body.error || `HTTP ${res.status}`);
    return body.token;
  } catch (err) {
    console.error(`${MODULE_ID} | Could not get LiveKit token from server:`, err);
    return "";
  }
}

/**
 * Replacement for LiveKitClient#sendJoinMessage(serverHost, token).
 * Foundry serves .html from Data/ as text/plain (XSS guard), so instead of navigating to
 * join.html we open a blank same-origin tab and write the page into it. Token never hits a URL.
 */
async function sendJoinMessage(serverHost, token) {
  const room = tokenRoom(token);
  // Tolerate a typed "wss://" or trailing slash; an empty host leaves liveKitUrl blank for join.html to report.
  const host = String(serverHost ?? "").trim().replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
  const html = await buildPage({ liveKitUrl: host ? `wss://${host}` : "", token, room });

  if (openAVTab(html, room)) return;

  // Pop-up blocked: a click is required, so offer a single obvious button once the UI exists.
  console.warn(`${MODULE_ID} | A/V tab blocked by pop-up blocker, asking for click`);
  if (!game.ready) await new Promise((resolve) => Hooks.once("ready", resolve));
  await foundry.applications.api.DialogV2.prompt({
    window: { title: "Voice Chat" },
    content: `<p style="font-size:1.2em">Click the button to join voice chat.</p>
      <p><em>Tip: allow pop-ups for this site and this step goes away next time.</em></p>`,
    ok: {
      label: "Join voice chat",
      icon: "fa-solid fa-microphone",
      callback: () => {
        if (!openAVTab(html, room)) ui.notifications.error("Your browser blocked the voice chat tab. Allow pop-ups for this site.");
      }
    },
    rejectClose: false
  });
}

/** Open (or reuse) the named A/V tab. Returns false if the pop-up was blocked. Must stay synchronous. */
function openAVTab(html, room) {
  // Named window: reloading Foundry finds the existing A/V tab instead of opening another.
  const win = window.open("", WINDOW_NAME);
  if (!win) return false;
  try {
    // Already in this room (e.g. Foundry page was reloaded): leave the call running.
    if (win.avConnected && win.avRoom === room) return true;
    win.avLeave?.();
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    console.error(`${MODULE_ID} | Could not write A/V tab`, err);
    ui.notifications.error("Could not start voice chat tab. Close the extra Voice Chat tab and reload.");
  }
  return true;
}

let templateCache;
async function buildPage(config) {
  // getRoute strips trailing slashes; base must end in "/" for <base href> and relative URLs.
  const base = new URL(`${foundry.utils.getRoute(`modules/${MODULE_ID}`)}/`, window.location.origin).href;
  if (!templateCache) {
    const res = await fetch(`${base}join.html`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${MODULE_ID} | Could not load join.html (${res.status} ${res.url})`);
    templateCache = await res.text();
  }
  // Escape "<" so config values can't close the script tag.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return templateCache
    .replace("<!--AVJOIN-BASE-->", () => `<base href="${base}">`)
    .replace("<!--AVJOIN-CONFIG-->", () => `<script>window.AVJOIN = ${json};</script>`);
}

/** Room name from the LiveKit JWT (breakouts use a different room, so the tab must rejoin). */
function tokenRoom(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).video?.room ?? null;
  } catch {
    return null;
  }
}

Hooks.once("ready", () => {
  if (!HOST_IS_PLACEHOLDER || !game.user.isGM) return;
  const msg = `${MODULE_ID}: LIVEKIT_HOST in avautojoin.js is still the placeholder, so voice will not connect. Set it to your LiveKit host.`;
  console.error(msg);
  ui.notifications.error(msg, { permanent: true });
});
