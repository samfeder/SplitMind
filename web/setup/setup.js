// SplitMind setup page: one place to connect every Gmail, Notion and Slack account by OAuth.
//
// Served as a static asset at <origin>/setup/ (scripts/deploy.ts copies web/setup/ into the Web Console build). It
// only calls the Worker's own console API with the admin session cookie, plus Slack's apps.manifest.create straight
// from the browser, so a Slack configuration token never reaches the Worker.
//
// The pure helpers are exported for tests/setup-page.test.ts; main() runs only in a browser.

export const PROVIDERS = ["gmail", "notion", "slack"];

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Why a nickname can't be used, or undefined when it can. Mirrors upstream's connection-name rule. */
export function nicknameProblem(name, taken = []) {
  if (!name) return "Type a nickname, like home or work.";
  if (!NAME_PATTERN.test(name)) return "Use letters, digits, _ and - only (up to 64), starting with a letter or digit.";
  if (name.toLowerCase() === "default") return "Pick a real nickname: SplitMind never keeps a default account.";
  if (taken.includes(name)) return `${name} is already connected. Pick another nickname, or use Reconnect.`;
  return undefined;
}

/**
 * Google signs in with whichever account the browser already uses unless asked otherwise, which would store the
 * same mailbox twice. Ask for the account chooser on every Gmail connect, so no private window is needed.
 */
export function withGoogleAccountChooser(authorizationUrl) {
  const url = new URL(authorizationUrl);
  if (url.hostname !== "accounts.google.com") return authorizationUrl;
  const prompts = new Set((url.searchParams.get("prompt") ?? "").split(" ").filter(Boolean));
  prompts.add("select_account");
  prompts.add("consent");
  url.searchParams.set("prompt", [...prompts].join(" "));
  return url.toString();
}

/** slack/app-manifest.json with this deployment's origin and a per-workspace app name filled in. */
export function renderSlackManifest(manifestText, origin, nickname) {
  if (!/^https:\/\/[^/\s]+$/.test(origin)) throw new Error("origin must be https://host with no path");
  const manifest = JSON.parse(manifestText.replaceAll("<origin>", origin));
  if (nickname) manifest.display_information.name = `SplitMind (${nickname})`.slice(0, 35);
  return manifest;
}

/** The Slack app's client credentials from an apps.manifest.create response, or a readable error. */
export function slackCredentials(response) {
  if (!response?.ok) {
    const reason = response?.error ?? "unknown_error";
    const hints = {
      invalid_auth: "Slack didn't accept the configuration token. Generate a fresh one (they last 12 hours).",
      token_expired: "That configuration token has expired. Generate a fresh one.",
      not_authed: "Paste the configuration token first.",
    };
    const detail = (response?.errors ?? []).map((error) => `${error.pointer ?? ""} ${error.message ?? ""}`.trim());
    throw new Error([hints[reason] ?? `Slack refused to create the app (${reason}).`, ...detail].join(" "));
  }
  const { client_id: clientId, client_secret: clientSecret } = response.credentials ?? {};
  if (!clientId || !clientSecret) throw new Error("Slack created the app but sent no client credentials.");
  return { appId: response.app_id, clientId, clientSecret };
}

/** Stored connections of one provider, without upstream's virtual and Marketplace entries. */
export function accountsOf(connections, service) {
  return connections.filter((c) => c.service === service && c.configured && !c.virtual && !c.marketplace);
}

// ---------------------------------------------------------------------------------------------------------------
// Browser-only code below.

async function api(method, path, body, headers = {}) {
  const init = { method, credentials: "same-origin", headers };
  if (body !== undefined) {
    init.headers = { ...headers, "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `Request failed (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload;
}

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "className") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

let state = { configs: new Map(), connections: [], manifest: undefined };

async function refresh() {
  const [configs, connections] = await Promise.all([api("GET", "/api/oauth/configs"), api("GET", "/api/connections")]);
  state.configs = new Map(configs.map((config) => [config.service, config]));
  state.connections = connections;
  render();
}

function setStatus(card, message, kind = "info") {
  const status = $(".status", card);
  status.textContent = message ?? "";
  status.dataset.kind = kind;
}

function pollUntilConnected(card, service, nickname) {
  const started = Date.now();
  const timer = setInterval(async () => {
    try {
      const connections = await api("GET", "/api/connections");
      const found = accountsOf(connections, service).find((c) => c.connectionName === nickname);
      if (found) {
        clearInterval(timer);
        state.connections = connections;
        render();
        const label = found.profile?.displayName ? ` (${found.profile.displayName})` : "";
        setStatus($(`[data-service="${service}"]`), `Connected ${nickname}${label}.`, "ok");
      } else if (Date.now() - started > 10 * 60_000) {
        clearInterval(timer);
        setStatus(card, "Still not connected after 10 minutes. Try Connect again.", "error");
      }
    } catch {
      // A transient failure; the next tick retries.
    }
  }, 2000);
}

function openPopup() {
  // Called inside the click, before any await, so the browser doesn't block it as a pop-up.
  return window.open("about:blank", "splitmind_oauth", "width=560,height=720");
}

async function startOAuth(card, service, nickname, clientConfig, popup = openPopup()) {
  try {
    const { authorizationUrl } = await api("POST", "/api/oauth/authorizations", {
      service,
      connectionName: nickname,
      ...clientConfig,
    });
    const url = withGoogleAccountChooser(authorizationUrl);
    if (popup) popup.location.href = url;
    else window.location.href = url;
    setStatus(card, `Finish signing in to ${nickname} in the window that opened. This page updates by itself.`);
    pollUntilConnected(card, service, nickname);
  } catch (error) {
    popup?.close();
    setStatus(card, error.message, "error");
  }
}

async function disconnect(card, service, nickname) {
  if (!window.confirm(`Disconnect ${nickname}? Claude loses access to it until you connect it again.`)) return;
  try {
    await api("DELETE", `/api/connections/${service}`, { connectionName: nickname, revoke: true });
    await refresh();
  } catch (error) {
    setStatus(card, error.message, "error");
  }
}

function copyButton(text) {
  return el(
    "button",
    {
      type: "button",
      className: "secondary small",
      onclick: async (event) => {
        await navigator.clipboard.writeText(text);
        event.target.textContent = "Copied";
        setTimeout(() => (event.target.textContent = "Copy"), 1500);
      },
    },
    "Copy",
  );
}

function redirectUri() {
  return `${window.location.origin}/oauth/callback`;
}

function privacyUri() {
  return `${window.location.origin}/privacy/`;
}

// One-time OAuth app instructions for the providers that use a deployment-wide app.
const APP_STEPS = {
  gmail: {
    title: "One-time: create the Google OAuth client (about 10 minutes)",
    steps: [
      ["In the ", ["Google Cloud console", "https://console.cloud.google.com/projectcreate"], ", create a project named splitmind."],
      ["Enable the ", ["Gmail API", "https://console.cloud.google.com/apis/library/gmail.googleapis.com"], " for it."],
      ["Google Auth Platform → ", ["Branding", "https://console.cloud.google.com/auth/branding"], ": app name SplitMind and your email. Under App domain, set the home page to this site and the privacy policy link to the privacy address below (Google won't publish the app without it)."],
      ["", ["Audience", "https://console.cloud.google.com/auth/audience"], ": External, then Publish app so it says In production. (Testing mode logs you out every 7 days.)"],
      ["", ["Clients", "https://console.cloud.google.com/auth/clients/create"], " → Create client → Web application. Under Authorized redirect URIs add the address below. Create, then paste the Client ID and Client secret here."],
    ],
    idLabel: "Client ID",
    secretLabel: "Client secret",
  },
  notion: {
    title: "One-time: create the Notion public connection (about 3 minutes)",
    steps: [
      ["Open the ", ["Notion developer portal", "https://www.notion.so/profile/integrations"], " → Public connections → Create new connection."],
      ["Name it SplitMind. Installation scope: Selected workspaces only, and tick every workspace you want to connect."],
      ["Capabilities: Read, Update and Insert content, plus Read and Insert comments."],
      ["Add the redirect URI below. Create it, then on the Configuration tab copy the OAuth client ID and client secret here."],
    ],
    idLabel: "OAuth client ID",
    secretLabel: "OAuth client secret",
  },
};

function stepList(steps) {
  return el(
    "ol",
    {},
    steps.map((parts) =>
      el(
        "li",
        {},
        parts.map((part) =>
          Array.isArray(part) ? el("a", { href: part[1], target: "_blank", rel: "noopener" }, part[0]) : part,
        ),
      ),
    ),
  );
}

function appSetup(card, service) {
  const info = APP_STEPS[service];
  const config = state.configs.get(service);
  if (config?.configured) {
    return el(
      "details",
      { className: "app" },
      el("summary", {}, config.clientId ? `OAuth app saved (client ${config.clientId}). Replace it` : "OAuth app saved. Replace it"),
      appForm(card, service, info),
    );
  }
  return el(
    "div",
    { className: "app todo" },
    el("h3", {}, info.title),
    stepList(info.steps),
    el("p", { className: "uri" }, "Redirect URI: ", el("code", {}, redirectUri()), copyButton(redirectUri())),
    service === "gmail"
      ? el("p", { className: "uri" }, "Privacy policy: ", el("code", {}, privacyUri()), copyButton(privacyUri()))
      : null,
    appForm(card, service, info),
  );
}

function appForm(card, service, info) {
  return el(
    "form",
    {
      className: "row",
      onsubmit: async (event) => {
        event.preventDefault();
        const form = event.target;
        try {
          await api("PUT", `/api/oauth/configs/${service}`, {
            clientId: form.clientId.value.trim(),
            clientSecret: form.clientSecret.value.trim(),
          });
          await refresh();
          setStatus($(`[data-service="${service}"]`), "Saved. Now connect your first account below.", "ok");
        } catch (error) {
          setStatus(card, error.message, "error");
        }
      },
    },
    el("input", { name: "clientId", placeholder: info.idLabel, required: true, autocomplete: "off" }),
    el("input", { name: "clientSecret", type: "password", placeholder: info.secretLabel, required: true, autocomplete: "off" }),
    el("button", { type: "submit" }, "Save"),
  );
}

function accountList(card, service) {
  const accounts = accountsOf(state.connections, service);
  if (accounts.length === 0) return el("p", { className: "muted" }, "No accounts connected yet.");
  return el(
    "ul",
    { className: "accounts" },
    accounts.map((account) =>
      el(
        "li",
        {},
        el("strong", {}, account.connectionName),
        el("span", { className: "muted" }, account.profile?.displayName ?? ""),
        account.default ? el("span", { className: "badge warn" }, "default: disconnect and reconnect with a nickname") : null,
        account.status === "reauth_required" ? el("span", { className: "badge warn" }, "needs reconnect") : null,
        service !== "slack" && account.authType === "oauth2"
          ? el("button", { type: "button", className: "secondary small", onclick: () => startOAuth(card, service, account.connectionName) }, "Reconnect")
          : null,
        el("button", { type: "button", className: "secondary small", onclick: () => disconnect(card, service, account.connectionName) }, "Disconnect"),
      ),
    ),
  );
}

function connectForm(card, service) {
  const taken = accountsOf(state.connections, service).map((c) => c.connectionName);
  const label = { gmail: "Connect a mailbox", notion: "Connect a workspace", slack: "Connect a workspace" }[service];
  return el(
    "form",
    {
      className: "row",
      onsubmit: (event) => {
        event.preventDefault();
        const nickname = event.target.nickname.value.trim();
        const problem = nicknameProblem(nickname, taken);
        if (problem) return setStatus(card, problem, "error");
        if (service === "slack") return connectSlack(card, nickname, event.target);
        startOAuth(card, service, nickname);
      },
    },
    el("input", { name: "nickname", placeholder: "Nickname, e.g. home or work", required: true, autocomplete: "off" }),
    service === "slack"
      ? el("input", { name: "configToken", type: "password", placeholder: "Slack configuration token (xoxe.xoxp-…)", autocomplete: "off" })
      : null,
    el("button", { type: "submit" }, label),
    service === "slack" ? slackManual() : null,
  );
}

function slackManual() {
  return el(
    "details",
    { className: "manual" },
    el("summary", {}, "Already made the Slack app yourself? Paste its credentials instead"),
    el("input", { name: "clientId", placeholder: "Client ID", autocomplete: "off" }),
    el("input", { name: "clientSecret", type: "password", placeholder: "Client Secret", autocomplete: "off" }),
  );
}

async function connectSlack(card, nickname, form) {
  const manualId = form.clientId.value.trim();
  const manualSecret = form.clientSecret.value.trim();
  if (manualId && manualSecret) return startOAuth(card, "slack", nickname, { clientId: manualId, clientSecret: manualSecret });
  const token = form.configToken.value.trim();
  if (!token) return setStatus(card, "Paste a configuration token (see step 1), or open the credentials box below.", "error");
  const popup = openPopup();
  try {
    setStatus(card, "Creating the SplitMind app in that workspace…");
    state.manifest ??= await (await fetch("./slack-manifest.json")).text();
    const manifest = renderSlackManifest(state.manifest, window.location.origin, nickname);
    // A form-encoded POST is a CORS "simple request": no preflight, and the token stays in the browser.
    const response = await fetch("https://slack.com/api/apps.manifest.create", {
      method: "POST",
      body: new URLSearchParams({ token, manifest: JSON.stringify(manifest) }),
    });
    const credentials = slackCredentials(await response.json());
    form.configToken.value = "";
    await startOAuth(card, "slack", nickname, { clientId: credentials.clientId, clientSecret: credentials.clientSecret }, popup);
  } catch (error) {
    popup?.close();
    const message =
      error instanceof TypeError
        ? "Your browser couldn't reach Slack's API from this page. Use the credentials box below instead (steps in docs/providers/slack.md)."
        : error.message;
    setStatus(card, message, "error");
  }
}

const TITLES = { gmail: "Gmail", notion: "Notion", slack: "Slack" };
const HINTS = {
  gmail: "Google shows an account chooser each time, so pick the mailbox you mean. On the unverified-app screen click Advanced → Go to SplitMind: it's your own app.",
  notion: "Notion asks which workspace and which pages to share. Pick only the pages Claude should see; you can add more later from a page's ••• → Connections.",
  slack: "Once per workspace. On api.slack.com/apps, under Your App Configuration Tokens, click Generate Token, pick the workspace and copy the Access Token. Paste it here with a nickname, then click Allow on Slack's screen. The token is used once, in your browser, and never stored.",
};

function render() {
  const main = $("#providers");
  main.replaceChildren(
    ...PROVIDERS.map((service) => {
      const card = el("section", { className: "card", "data-service": service });
      const needsApp = service !== "slack" && !state.configs.get(service)?.configured;
      // Element.append turns null into the text "null", so drop the parts this card doesn't show.
      const parts = [
        el("h2", {}, TITLES[service]),
        service === "slack" ? null : appSetup(card, service),
        accountList(card, service),
        needsApp ? null : el("p", { className: "hint" }, HINTS[service]),
        needsApp ? null : connectForm(card, service),
        el("p", { className: "status", role: "status" }),
      ];
      card.append(...parts.filter((part) => part !== null));
      return card;
    }),
  );
}

async function signIn(event) {
  event.preventDefault();
  const token = event.target.token.value.trim();
  const session = await api("GET", "/api/auth/session", undefined, { authorization: `Bearer ${token}` });
  if (!session.authenticated) {
    $("#signin-status").textContent = "That admin token didn't work.";
    return;
  }
  event.target.token.value = "";
  await start();
}

async function start() {
  const session = await api("GET", "/api/auth/session");
  $("#signin").hidden = session.authenticated;
  $("#providers").hidden = !session.authenticated;
  if (session.authenticated) await refresh();
}

export function main() {
  $("#signin form").addEventListener("submit", (event) =>
    signIn(event).catch((error) => ($("#signin-status").textContent = error.message)),
  );
  start().catch((error) => ($("#signin-status").textContent = error.message));
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.querySelector("#providers")) main();
