// ==UserScript==
// @name         Healthie Care Plan Integration
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  Injecting care plan components into Healthie
// @author       Don, Tonye, Alejandro
// @match        https://*.gethealthie.com/*
// @match        https://vorihealth.gethealthie.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=vori.health
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      browser-intake-datadoghq.com
// ==/UserScript==

/* globals contentful */

//Enable/Disable debug mode
let debug = false;
let previousUrl = "";
let patientNumber = "";
let carePlanLoopLock = 0;
let searchInterceptorUrl = "";
//Keep track of timeouts
let timeoutIds = [];
let intervalIds = [];
const maxWaitAttempts = 25;
// Shorter bound than maxWaitAttempts: this poll runs at 1s and its target only
// renders once the header search is used, so a long wait would just idle.
const maxSearchResultsWaitAttempts = 5;
// Check for Healthie environment
const isStagingEnv = location.href.includes("securestaging") ? true : false;
let mishaURL = isStagingEnv ? "qa.misha.vori.health/" : "misha.vorihealth.com/";
let healthieURL = isStagingEnv ? "securestaging.gethealthie.com" : "vorihealth.gethealthie.com";
let healthieAPIKey = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", "");
let auth = `Basic ${healthieAPIKey}`;
const urlValidation = {
  apiKeys: /\/settings\/api_keys$/,
  appointments: /\/appointments|\/organization|\/providers\//,
  appointmentsHome: /^https?:\/\/[^/]+\.com(\/overview|\/)?$/,
  appointmentsProfile:
    /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview|overview|custom_nav_items\/\d+))?\/?(\?.*)?$/,
  membership:
    /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Overview|Actions|overview|actions|custom_nav_items\/\d+))?\/?(\?.*)?$/,
  verifyEmailPhone: /^https?:\/\/([^\/]+)?\.?([^\/]+)\/users\/\d+(?:\/(?:Actions|actions))\/?(\?.*)?$/,
  carePlan: /\/all_plans$/,
  clientList: /\/clients\/active/,
  conversations: /\/conversations/,
  goals: /\/users/,
  landingPage: /\/$/,
  editChartingNote: /private_notes\/edit/,
};
let isEmailVerified = true;
let isPhoneNumberVerified = true;
let isLoadingEmailPhone = true;
let patientGroupName = "";

function debugLog(...messages) {
  if (isStagingEnv || debug) {
    unsafeWindow.console.log(...messages);
  }
}

// Same public browser logs token as DATADOG_LOGS_CLIENT_TOKEN in
// voya-cust web-misha/core-lib/config/envs.ts. Not the server API key.
const TM_VERSION = "2.6";
const DD_LOGS_CLIENT_TOKEN = "pubdf55240f49807c01cd3ed2168506ced8";
const DD_INTAKE_URL =
  "https://browser-intake-datadoghq.com/api/v2/logs?ddsource=browser&dd-evp-origin=browser&dd-api-key=" +
  DD_LOGS_CLIENT_TOKEN;
const DD_LIMITS_PER_MINUTE = { error: 20, warn: 20, info: 30 };
const ddInstallIdKey = "voriDatadogInstallId";
const ddProbeAtKey = "voriDatadogProbeAt";
const DD_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function randomId(length) {
  try {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
  } catch (e) {
    // Missing crypto must not stop the userscript.
    return "unavailable";
  }
}

const ddPageId = randomId(10);

function readInstallId() {
  const id = randomId(12);
  try {
    const existing = GM_getValue(ddInstallIdKey, "");
    if (typeof existing === "string" && /^[a-z0-9]{12}$/.test(existing)) {
      return existing;
    }
    GM_setValue(ddInstallIdKey, id);
  } catch (e) {
    // Telemetry storage must not prevent the userscript from starting.
  }
  return id;
}

const ddInstallId = readInstallId();
let ddQueue = [];
let ddSentBySeverity = { error: 0, warn: 0, info: 0 };
let ddWindowStarted = Date.now();
let ddFlushTimer = null;
let ddHooksInstalled = false;
let ddLastMessage = "";
let ddLastAt = 0;

function sanitizeToken(token) {
  const withoutQuery = token.split("?")[0].split("#")[0];
  return withoutQuery.includes("@") ? "[email]" : withoutQuery;
}

function sanitizeForDatadog(value) {
  return String(value ?? "")
    .split(/\s+/)
    .map(sanitizeToken)
    .join(" ")
    .slice(0, 500);
}

// Only static route names are sent. IDs, filenames and unknown path segments may contain PHI.
const DD_ROUTE_SEGMENTS = new Set([
  "users",
  "private_notes",
  "edit",
  "graphql",
  "settings",
  "api_keys",
  "appointments",
  "overview",
  "Overview",
  "actions",
  "Actions",
  "organization",
  "providers",
  "clients",
  "active",
  "all_plans",
  "conversations",
  "custom_nav_items",
  "schedule",
  "careplan",
  "app",
  "appointment",
  "patientStatusStandalone",
  "provider-schedule",
  "otpVerifyStandalone",
  "createPatientDialog",
]);

function normalizePath(pathname) {
  return String(pathname || "")
    .split("/")
    .map((segment) => {
      if (!segment || DD_ROUTE_SEGMENTS.has(segment)) return segment;
      return /^\d+$/.test(segment) ? ":id" : ":redacted";
    })
    .join("/");
}

function safeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""), location.origin);
    const knownHost = /^(api|staging-api|secure|securestaging|vorihealth)\.gethealthie\.com$/.test(parsed.hostname);
    return (knownHost ? parsed.origin : "[external]") + normalizePath(parsed.pathname);
  } catch (e) {
    // Malformed diagnostic URLs are omitted.
    return "invalid-url";
  }
}

function errorFingerprint(value) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i);
    hash ^= codePoint;
    hash = Math.imul(hash, 16777619);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeErrorName(value) {
  const names = [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "AggregateError",
    "AbortError",
    "NetworkError",
    "TimeoutError",
    "SecurityError",
    "InvalidStateError",
    "GraphQLError",
    "ApolloError",
  ];
  return names.includes(value) ? value : "Error";
}

function errorSummary(kind, error) {
  const message = typeof error?.message === "string" ? error.message : String(error || kind);
  const name = safeErrorName(error?.name);
  return kind + "_error name=" + name + " fingerprint=" + errorFingerprint(message);
}

function rollDatadogWindow() {
  const now = Date.now();
  if (now - ddWindowStarted < 60000) {
    return;
  }
  ddWindowStarted = now;
  ddSentBySeverity = { error: 0, warn: 0, info: 0 };
}

function datadogSeverity(status) {
  return DD_LIMITS_PER_MINUTE[status] ? status : "info";
}

function makeDatadogLog(status, kind, message, extra) {
  const severity = datadogSeverity(status);
  const env = isStagingEnv ? "staging" : "prod";
  const entry = {
    message: sanitizeForDatadog("[" + kind + "] " + message),
    status: severity,
    service: "tampermonkey-healthie",
    ddsource: "browser",
    ddtags: "env:" + env + ",version:" + TM_VERSION + ",kind:" + kind + ",severity:" + severity,
    tm_version: TM_VERSION,
    tm_kind: kind,
    tm_severity: severity,
    tm_install_id: ddInstallId,
    healthie_path: normalizePath(location.pathname),
    page_id: ddPageId,
  };
  if (!extra) {
    return entry;
  }
  return { ...entry, ...extra };
}

function reportDatadogStatus(onResult, status) {
  try {
    if (onResult) onResult(status);
  } catch (e) {
    // Even a failed probe timestamp write must stay inside telemetry.
  }
}

function sendDatadogBatch(batch, onResult) {
  try {
    GM_xmlhttpRequest({
      method: "POST",
      url: DD_INTAKE_URL,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(batch),
      timeout: 10000,
      onload: (response) => reportDatadogStatus(onResult, response.status),
      onerror: () => reportDatadogStatus(onResult, 0),
      ontimeout: () => reportDatadogStatus(onResult, 0),
      onabort: () => reportDatadogStatus(onResult, 0),
    });
  } catch (e) {
    reportDatadogStatus(onResult, 0);
  }
}

function enqueueDatadogLog(status, kind, message, extra) {
  try {
    const severity = datadogSeverity(status);
    const now = Date.now();
    const dedupeKey = severity + "|" + kind + "|" + message;
    if (dedupeKey === ddLastMessage && now - ddLastAt < 2000) {
      return;
    }
    ddLastMessage = dedupeKey;
    ddLastAt = now;
    rollDatadogWindow();
    if (ddSentBySeverity[severity] >= DD_LIMITS_PER_MINUTE[severity]) {
      return;
    }
    ddSentBySeverity[severity] += 1;
    ddQueue.push(makeDatadogLog(severity, kind, message, extra));
    if (!ddFlushTimer) {
      ddFlushTimer = window.setTimeout(flushDatadogLogs, 1000);
    }
  } catch (e) {
    // A logging failure must not interrupt the Healthie page.
  }
}

function flushDatadogLogs() {
  ddFlushTimer = null;
  if (!ddQueue.length || typeof GM_xmlhttpRequest !== "function") {
    ddQueue = [];
    return;
  }
  const batch = ddQueue.splice(0, 10);
  sendDatadogBatch(batch);
  if (ddQueue.length) {
    ddFlushTimer = window.setTimeout(flushDatadogLogs, 1000);
  }
}

function isGraphqlValidationMessage(value) {
  return value && typeof value === "object" && "field" in value && typeof value.message === "string";
}

function graphqlErrorSummary(text) {
  if (!text || text.length > 200000) {
    return "";
  }
  try {
    const body = JSON.parse(text);
    const errors = Array.isArray(body?.errors) ? body.errors.length : 0;
    // Healthie also rejects mutations through data.<mutation>.messages.
    const messages = Object.values(body?.data || {}).reduce(
      (count, payload) =>
        count + (Array.isArray(payload?.messages) ? payload.messages.filter(isGraphqlValidationMessage).length : 0),
      0
    );
    const count = errors + messages;
    return count ? "count=" + count : "";
  } catch (error) {
    debugLog("tampermonkey skipped non-json graphql body", error);
    return "";
  }
}

function httpSeverity(status) {
  return status >= 500 ? "error" : "warn";
}

function noteHttpResult(method, rawUrl, status) {
  if (status < 400) {
    return;
  }
  enqueueDatadogLog(httpSeverity(status), "http", method + " " + status + " " + safeUrl(rawUrl), {
    http_status: status,
  });
}

function noteGraphqlText(rawUrl, text) {
  if (!/graphql/i.test(String(rawUrl || ""))) {
    return;
  }
  const summary = graphqlErrorSummary(text);
  if (summary) {
    enqueueDatadogLog("warn", "graphql", summary + " " + safeUrl(rawUrl));
  }
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || "GET").toUpperCase();
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url || "";
}

function noteFetchResponse(method, rawUrl, response) {
  try {
    noteHttpResult(method, rawUrl, response.status);
    if (!response.ok || !response.clone || !/graphql/i.test(rawUrl)) {
      return;
    }
    response
      .clone()
      .text()
      .then(function (text) {
        noteGraphqlText(rawUrl, text);
      })
      .catch(function () {
        // Ignore a response body that cannot be cloned.
      });
  } catch (e) {
    // Observing a response must not change the value returned to Healthie.
  }
}

function noteFetchFailure(method, rawUrl, error) {
  try {
    if (error?.name === "AbortError") {
      return;
    }
    const detail = method + " network_error " + safeUrl(rawUrl) + " fingerprint=" + errorFingerprint(error?.message);
    enqueueDatadogLog("error", "http", detail);
  } catch (e) {
    // A logging failure must not replace the original network error.
  }
}

function hookPageFetch(targetWindow) {
  const pageFetch = targetWindow.fetch;
  if (!pageFetch || pageFetch.__vxWrapped) {
    return;
  }
  function wrappedFetch(input, init) {
    const result = pageFetch.apply(this, arguments);
    let method, rawUrl;
    try {
      method = requestMethod(input, init);
      rawUrl = requestUrl(input);
    } catch (e) {
      // Preserve the native promise even if optional metadata cannot be read.
      return result;
    }
    return result.then(
      function (response) {
        noteFetchResponse(method, rawUrl, response);
        return response;
      },
      function (error) {
        noteFetchFailure(method, rawUrl, error);
        throw error;
      }
    );
  }
  wrappedFetch.__vxWrapped = true;
  targetWindow.fetch = wrappedFetch;
}

function onXhrLoadEnd() {
  noteXhrResult(this);
}
function onXhrNetworkError() {
  noteFetchFailure(this.__vxMethod || "GET", this.__vxUrl, { message: "xhr network failure" });
}

function hookPageXhr() {
  const XHR = unsafeWindow.XMLHttpRequest;
  if (!XHR || XHR.__vxWrapped) {
    return;
  }
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;
  XHR.prototype.open = function (method, url) {
    const result = origOpen.apply(this, arguments);
    try {
      this.__vxMethod = method;
      this.__vxUrl = url;
    } catch (e) {
      // Request metadata is optional.
    }
    return result;
  };
  XHR.prototype.send = function () {
    try {
      // Reusing an XHR must not accumulate observers across sends.
      this.addEventListener("loadend", onXhrLoadEnd);
      this.addEventListener("error", onXhrNetworkError);
      this.addEventListener("timeout", onXhrNetworkError);
    } catch (e) {
      // A failed observer must not prevent the native send.
    }
    return origSend.apply(this, arguments);
  };
  XHR.__vxWrapped = true;
}

function noteXhrResult(xhr) {
  try {
    const method = (xhr.__vxMethod || "GET").toUpperCase();
    noteHttpResult(method, xhr.__vxUrl, xhr.status);
    if (xhr.status === 200 && /graphql/i.test(String(xhr.__vxUrl || ""))) {
      noteGraphqlText(xhr.__vxUrl, xhr.responseText);
    }
  } catch (e) {
    // Observing XHR must not change the request Healthie sent.
  }
}

function isErrorWithMessage(value) {
  return Boolean(value && typeof value.message === "string" && (typeof value.stack === "string" || value.name));
}

function consoleErrorText(args) {
  const parts = [];
  const limit = Math.min(args.length, 3);
  for (let i = 0; i < limit; i++) {
    const value = args[i];
    if (isErrorWithMessage(value)) {
      parts.push(value.message);
    } else if (typeof value === "string") {
      parts.push(value);
    }
  }
  return parts.join(" ");
}

function hookPageConsoleError(targetWindow) {
  if (!targetWindow.console || targetWindow.console.__vxWrapped) {
    return;
  }
  const originalError = targetWindow.console.error;
  targetWindow.console.error = function () {
    try {
      const text = consoleErrorText(arguments);
      if (text) {
        enqueueDatadogLog("error", "console", errorSummary("console", { message: text }));
      }
    } catch (e) {
      // Keep the original console.error working if logging fails.
    }
    return originalError.apply(this, arguments);
  };
  targetWindow.console.__vxWrapped = true;
}

function windowErrorDetail(event, fallbackMessage) {
  const error = event?.error ? event.error : { message: fallbackMessage };
  let detail = errorSummary("window", error);
  if (event?.filename) {
    detail += " @ " + safeUrl(event.filename) + ":" + (event.lineno || "");
  }
  return detail;
}

function watchWindowErrors(targetWindow) {
  targetWindow.addEventListener("error", function (event) {
    if (event.target && event.target !== targetWindow) {
      return;
    }
    const message = event?.message ? event.message : "error";
    if (message === "Script error.") {
      return;
    }
    enqueueDatadogLog("error", "window", windowErrorDetail(event, message));
  });
  targetWindow.addEventListener("unhandledrejection", function (event) {
    const reason = event?.reason;
    enqueueDatadogLog("error", "unhandledrejection", errorSummary("unhandledrejection", reason));
  });
}

function chartNoteAction(label) {
  if (label.includes("sign and lock") || label.includes("sign & lock")) {
    return "sign and lock";
  }
  if (label === "lock" || label === "lock note") return "lock";
  if (label === "sign" || label === "sign note") return "sign";
  return "";
}

function watchChartNoteActions() {
  document.addEventListener(
    "click",
    function (event) {
      const button = event.target?.closest?.("button, [role='button']");
      if (!button) {
        return;
      }
      const label = (button.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      const action = chartNoteAction(label);
      if (!action) {
        return;
      }
      enqueueDatadogLog("info", "chart-note", "clicked " + action);
    },
    true
  );
}

// Call before a page reload so queued logs are not lost with the page.
function flushDatadogLogsNow() {
  if (ddFlushTimer) {
    window.clearTimeout(ddFlushTimer);
  }
  while (ddQueue.length) {
    flushDatadogLogs();
    if (ddFlushTimer) window.clearTimeout(ddFlushTimer);
  }
  ddFlushTimer = null;
}

function routeName(routeURL) {
  const path = String(routeURL || "")
    .split("?")[0]
    .split("#")[0];
  return normalizePath("/" + path).replace(/^\/+/, "") || "root";
}

function noteRetryExhausted(giveUpMessage, attempts) {
  enqueueDatadogLog("warn", "retry-exhausted", String(giveUpMessage || "").replace("tampermonkey ", ""), {
    retry_attempts: attempts,
  });
}

// Cross-origin iframes rarely fire "error", so a missing "load" is the failure signal.
// Normal loads are not logged so they can't use up the info cap that chart-note relies on.
const DD_IFRAME_LOAD_TIMEOUT_MS = 20000;
const DD_IFRAME_SLOW_MS = 5000;

function watchIframeLoad(iframeNode, routeURL) {
  if (!iframeNode?.addEventListener) {
    return;
  }
  const route = routeName(routeURL);
  const startedAt = Date.now();
  let settled = false;
  const settle = function (status, outcome) {
    if (settled) {
      return;
    }
    settled = true;
    const loadMs = Date.now() - startedAt;
    if (outcome === "loaded" && loadMs < DD_IFRAME_SLOW_MS) {
      return;
    }
    enqueueDatadogLog(status, "iframe", outcome + " " + route, { load_ms: loadMs });
  };
  iframeNode.addEventListener("load", function () {
    settle("info", "loaded");
  });
  iframeNode.addEventListener("error", function () {
    settle("warn", "failed");
  });
  window.setTimeout(function () {
    if (iframeNode.isConnected) {
      settle("warn", "timeout");
    }
  }, DD_IFRAME_LOAD_TIMEOUT_MS);
}

// Leaves out basicInformationHeight and the verification status updates, which Misha
// sends often enough to use up the per-minute info cap.
const MISHA_MESSAGE_TYPES = [
  "tmInput",
  "reschedule",
  "reload",
  "closeWindow",
  "patientProfile",
  "newChartNoteId",
  "patientGroupName",
  "healthieActionsTab",
  "verifyEmail",
  "verifyPhone",
];

function noteMishaMessage(data) {
  if (typeof data !== "object") {
    return;
  }
  const types = MISHA_MESSAGE_TYPES.filter((type) => data[type] !== undefined);
  if (types.length) {
    enqueueDatadogLog("info", "misha-message", "received " + types.join(","));
  }
}

function maybeSendDailyProbe() {
  const lastProbeAt = Number(GM_getValue(ddProbeAtKey, 0)) || 0;
  if (Date.now() - lastProbeAt < DD_PROBE_INTERVAL_MS) {
    return;
  }
  const entry = makeDatadogLog("info", "probe", "daily probe version=" + TM_VERSION);
  sendDatadogBatch([entry], function (status) {
    if (status >= 200 && status < 300) {
      GM_setValue(ddProbeAtKey, Date.now());
    }
  });
}

function setupHealthieDatadogLogs() {
  if (ddHooksInstalled) {
    return;
  }
  ddHooksInstalled = true;
  const hooks = [
    () => hookPageFetch(unsafeWindow),
    () => hookPageFetch(window),
    hookPageXhr,
    () => hookPageConsoleError(unsafeWindow),
    () => hookPageConsoleError(window),
    () => watchWindowErrors(unsafeWindow),
    () => {
      if (unsafeWindow !== window) watchWindowErrors(window);
    },
    watchChartNoteActions,
    () => window.addEventListener("pagehide", flushDatadogLogsNow),
    installDatadogSelfTest,
    maybeSendDailyProbe,
  ];
  for (const hook of hooks) {
    try {
      hook();
    } catch (e) {
      // One unavailable API must not disable the remaining observers or the userscript.
    }
  }
  const apiKeyState = typeof healthieAPIKey === "string" && healthieAPIKey ? "present" : "missing";
  enqueueDatadogLog("info", "lifecycle", "started version=" + TM_VERSION + " api_key=" + apiKeyState);
}

function installDatadogSelfTest() {
  unsafeWindow.__voriDatadogTest = function () {
    const testId = Date.now().toString(36) + randomId(8);
    const entry = makeDatadogLog("info", "diagnostic", "VX-3525 manual test " + testId);
    entry.test_id = testId;
    return new Promise(function (resolve) {
      sendDatadogBatch([entry], function (status) {
        const result = {
          accepted: status >= 200 && status < 300,
          status: status,
          test_id: testId,
          service: "tampermonkey-healthie",
          tm_install_id: ddInstallId,
          page_id: ddPageId,
        };
        unsafeWindow.__voriDatadogLastStatus = result;
        resolve(result);
      });
    });
  };
}

const routeURLs = {
  schedule: "schedule",
  careplan: "careplan",
  goals: "app/schedule",
  appointment: "appointment",
  appointments: "appointments",
  patientStatus: "patientStatusStandalone",
  providerSchedule: "provider-schedule",
  otpVerify: "otpVerifyStandalone",
  createPatientDialog: "createPatientDialog",
};

const styles = {
  scheduleOverlay: {
    display: "inline-block",
    background: "rgb(255, 255, 255)",
    maxWidth: "90vw", // fallback for browsers that don't support svw
    maxWidth: "90svw",
    width: "100vw",
    height: "90vh", // fallback for browsers that don't support svh
    height: "90svh",
    overflow: "hidden",
  },
  patientDialogOverlay: {
    display: "inline-block",
    background: "rgb(255, 255, 255)",
    maxWidth: "60vw", // fallback for browsers that don't support svw
    maxWidth: "60svw",
    width: "462px",
    height: "80vh", // fallback for browsers that don't support svh
    height: "80svh",
    overflow: "hidden",
  },
  appointmentDetailsOverlay: {
    height: "350px",
    width: "100%",
    overflow: "hidden",
  },
  otpOverlay: {
    width: "500px",
    height: "500px",
  },
};

function createTimeout(timeoutFunction, delay) {
  let timeoutId = window.setTimeout(() => {
    timeoutFunction();
    // Remove timeoutId from the array after function execution
    // debugLog(`tampermonkey remove timeout ${timeoutId}`);
    timeoutIds = timeoutIds.filter((id) => id !== timeoutId);
  }, delay);
  //debugLog(`tampermonkey create timeout ${timeoutId}`);
  timeoutIds.push(timeoutId);
  return timeoutId;
}

function scheduleRetryOrStop(retryFn, attempt, maxAttempts, delay, giveUpMessage, waitingMessage) {
  if (attempt < maxAttempts) {
    if (waitingMessage) {
      debugLog(waitingMessage);
    }
    createTimeout(() => retryFn(attempt + 1), delay);
    return;
  }
  debugLog(giveUpMessage);
  noteRetryExhausted(giveUpMessage, attempt);
}

function waitForJQueryOrRetry(retryFn, attempt, giveUpMessage, waitingMessage) {
  const $ = initJQuery();
  if ($) {
    return $;
  }
  scheduleRetryOrStop(
    retryFn,
    attempt,
    maxWaitAttempts,
    200,
    giveUpMessage,
    waitingMessage || `tampermonkey waiting for jquery to load`
  );
  return null;
}

function clearAllTimeouts() {
  debugLog(`tampermonkey clear all timeouts`);
  timeoutIds.forEach((id) => {
    window.clearTimeout(id);
  });
  timeoutIds = [];
}

function clearMyTimeout(timeoutId) {
  if (!timeoutId) {
    return;
  }
  debugLog(`tampermonkey clear timeout ${timeoutId}`);
  window.clearTimeout(timeoutId);
  timeoutIds = timeoutIds.filter((id) => id !== timeoutId);
}

class WorkerInterval {
  worker = null;
  constructor(callback, interval) {
    const blob = new Blob([`setInterval(() => postMessage(0), ${interval});`]);
    const workerScript = URL.createObjectURL(blob);
    this.worker = new Worker(workerScript);
    this.worker.onmessage = callback;
  }

  stop() {
    this.worker.terminate();
  }
}

function createInterval(intervalFunction, delay) {
  let workerInterval = new WorkerInterval(() => {
    intervalFunction();
  }, delay);
  intervalIds.push(workerInterval);
  return workerInterval;
}

function clearAllIntervals() {
  debugLog(`tampermonkey clear all intervals`);
  for (let i = 0; i < intervalIds.length; i++) {
    intervalIds[i].stop();
  }
  intervalIds = [];
}

function initJQuery() {
  let $ = unsafeWindow.jQuery;
  if ($ && $ !== undefined && typeof $ === "function") {
    return $;
  } else {
    debugLog(`tampermonkey waiting for jquery to load`);
    const jquerySrc = "https://code.jquery.com/jquery-3.7.0.min.js";
    if (!document.querySelector(`script[src="${jquerySrc}"]`)) {
      let script = document.createElement("script");
      script.src = jquerySrc;
      script.type = "text/javascript";
      script.onload = function () {
        debugLog(`tampermonkey jquery loaded successfully`);
      };
      document.getElementsByTagName("head")[0].appendChild(script);
    }
    createTimeout(initJQuery, 200);
  }
}
initJQuery();

function convertToCSSProperty(jsProperty) {
  return jsProperty.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function generateIframe(routeURL, options = {}) {
  const $ = initJQuery();

  className = "misha-iframe-container";
  const iframeStyles = {
    height: options.height || "100vh",
    width: options.width || "100%",
    ...options,
  };
  // Convert iframeStyles object to CSS string
  const iframeStyleString = Object.entries(iframeStyles)
    .map(([property, value]) => `${convertToCSSProperty(property)}: ${value};`)
    .join(" ");

  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(function () {
      generateIframe(routeURL);
    }, 200);
    return;
  } else {
    const iframeElement = $("<div>")
      .css({ padding: "0", ...options })
      .addClass(className);

    const iframeContent = $("<iframe>", {
      id: "MishaFrame",
      title: "Misha iFrame",
      style: iframeStyleString,
      src: `https://${mishaURL}${routeURL}`,
    });
    iframeElement.append(iframeContent);
    watchIframeLoad(iframeContent[0], routeURL);
    debugLog(`tampermonkey generated iframe for ${routeURL}`);
    return iframeElement;
  }
}

function waitAppointmentsHome() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitAppointmentsHome, 200);
    return;
  } else {
    //check to see if the appointment view contents has loaded
    let appointmentWindow = document.getElementsByClassName("provider-home-appointments");
    if (appointmentWindow.length > 0) {
      debugLog(`tampermonkey found appointment view`, appointmentWindow.length);
      let appointmentWindowObj = appointmentWindow[0];
      //remove all except first child
      while (appointmentWindowObj.childNodes.length > 1) {
        let childClassName = appointmentWindowObj.lastChild.className;
        debugLog(`tampermonkey removing child `, childClassName);
        appointmentWindowObj.removeChild(appointmentWindowObj.lastChild);
      }

      // get the patient number from the URL
      patientNumber = location.href.split("/")[location.href.split("/").length - 1];

      // get the user data for provider id
      const getCurrentUserQuery = `query user{
        user(or_current_user: true){
         id
       }
       }`;

      const getCurrentUserPayload = JSON.stringify({
        query: getCurrentUserQuery,
      });
      healthieGQL(getCurrentUserPayload).then((response) => {
        const userId = response.data.user.id;
        //provider-schedule/id
        const iframeSrc = `https://${mishaURL}${routeURLs.providerSchedule}/${userId}`;

        // Check if the iframe already exists
        let existingIframe = document.querySelector(`iframe[src="${iframeSrc}"]`);
        // If the iframe doesn't exist, create a new one
        if (!existingIframe) {
          const iframe = generateIframe(`${routeURLs.providerSchedule}/${userId}`);
          $(appointmentWindowObj).append(iframe);
        }
      }).catch(reportHealthieRequestError);
    } else {
      //wait for content load
      debugLog(`tampermonkey waiting appointment view`);
      createTimeout(waitAppointmentsHome, 200);
    }
  }
}

function initBookAppointmentButton() {
  let bookAppointmentBtn = $("[data-testid='add-appointment-button']")[0];

  if (bookAppointmentBtn) {
    let patientNumber = location.href.split("/")[4];
    let clonedSec = $(bookAppointmentBtn).parent().clone();
    let appointmentSec = $(bookAppointmentBtn).parent().parent();
    $(bookAppointmentBtn).remove();
    debugLog(`tampermonkey parent element is `, $(appointmentSec).children()[0]);
    clonedSec.insertAfter($(appointmentSec).children()[0]);
    let newBookAppointmentBtn = $("[data-testid='add-appointment-button']")[0];
    let clonedBtn = $(newBookAppointmentBtn).clone();
    $(newBookAppointmentBtn).replaceWith(clonedBtn);
    clonedBtn.on("click", function (e) {
      e.stopPropagation();
      showOverlay(`${routeURLs.schedule}/${patientNumber}`, styles.scheduleOverlay);
    });
  } else {
    debugLog(`tampermonkey waiting for book appointment button`);
    createTimeout(initBookAppointmentButton, 200);
  }
}

function findAddClientButton($) {
  function matchesLabel(element) {
    return $(element).clone().find("svg").remove().end().text().trim()
      .replace(/\s+/g, " ").toLowerCase() === "add client";
  }
  const scopedButtons = $('[data-testid="new-client-modal-container"] button, .add-client-container button');
  return scopedButtons.filter(":visible").toArray().find(matchesLabel) ??
    $("button").filter(":visible").toArray().find(matchesLabel);
}

function handleAddClientClick(event) {
  const $ = initJQuery();
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (!$ || !button || button !== findAddClientButton($)) {
    return;
  }
  if (event.type.startsWith("key") && !["Enter", " "].includes(event.key)) {
    return;
  }
  // Preserve native click generation while blocking earlier React press handlers.
  event.stopImmediatePropagation();
  if (event.type === "click") {
    event.preventDefault();
    showOverlay(`${routeURLs.createPatientDialog}`, styles.patientDialogOverlay);
  }
}

function createPatientDialogIframe() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jQuery to load`);
    createTimeout(createPatientDialogIframe, 200);
    return;
  }
  debugLog(`jQuery is loaded, attempting to find 'Add Client' button`);
  const addPatientBtn = findAddClientButton($);
  if (addPatientBtn) {
    for (const type of ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "keydown", "keyup"]) {
      document.removeEventListener(type, handleAddClientClick, true);
      document.addEventListener(type, handleAddClientClick, true);
    }
  } else {
    debugLog(`'Add Client' button not found, retrying...`);
    createTimeout(createPatientDialogIframe, 200);
  }
}

function waitForAddPatientButton() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitForAddPatientButton, 200);
    return;
  }
  const addPatientBtn = findAddClientButton($);
  if (addPatientBtn) {
    debugLog("Add Client Button found");
    createPatientDialogIframe();
  } else {
    debugLog("Waiting for 'Add Client' button");
    createTimeout(waitForAddPatientButton, 200);
  }
}

function waitAppointmentsProfile() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitAppointmentsProfile, 200);
    return;
  } else {
    // check to see if the appointment view contents have loaded
    let appointmentWindow = $(
      $('[data-testid="cop-appointments-contents"]')[0] ?? '[data-testid="cop-appointments-section"] div'
    ).toArray().find(function (element) {
      return $(element).find('[data-testid="tab-container"]').length > 0;
    });
    if (appointmentWindow) {
      debugLog(`tampermonkey found appointment view on user profile`);
      $(appointmentWindow).siblings('[data-testid="misha-appointments"]').remove();

      // Clone the control while keeping Healthie's React-owned nodes attached.
      let appointmentBody = $(appointmentWindow).closest('[data-testid="collapsible-section-body"]');
      let bookAppointmentBtn =
        $('[data-testid="add-appointment-button"]')[0] ??
        appointmentBody
          .find('[data-testid="cop-appointments-contents"]')
          .siblings(".mt-3")
          .find("button")
          .toArray().find(function (element) {
            // Ignore the icon's SVG title when matching the visible label.
            return $(element).clone().find("svg").remove().end().text().trim() === "Add appointment";
          });
      let clonedBookBtn = null;
      if (bookAppointmentBtn) {
        clonedBookBtn = $(bookAppointmentBtn).clone().removeAttr("id")
          .attr("data-testid", "misha-add-appointment-button").show();
        $(bookAppointmentBtn).hide().closest(".mt-3").hide();
        debugLog(`tampermonkey cloned book appointment button`);
      }

      const appointmentReplacement = $("<div>", { "data-testid": "misha-appointments" })
        .css({ margin: "0", padding: "3px" });
      // get the parent with class .column.is-6 and change the width to 100%
      let parent = $(appointmentWindow).closest(".column.is-6");
      parent
        .css({
          width: "98%",
          minHeight: "420px",
          maxHeight: "max(60vh, 560px)",
          overflow: "scroll",
          marginTop: "2rem",
          padding: "0",
        })
        .closest(".columns") // also adjust style of grandparent
        .css({
          display: "flex",
          flexDirection: "column",
        });

      // also adjust width of packages section
      $('[data-testid="cop-appointments-section"]').closest(".column.is-6").css("width", "100%");

      // React must retain its original tree so later renders can update or remove it.
      $(appointmentWindow).hide().before(appointmentReplacement);

      if (clonedBookBtn) {
        const patientNumber = location.href.split("/")[4];
        clonedBookBtn.on("click", function (e) {
          e.stopPropagation();
          showOverlay(`${routeURLs.schedule}/${patientNumber}`, styles.scheduleOverlay);
        });
        appointmentReplacement.append(clonedBookBtn);
        debugLog(`tampermonkey added book appointment button before iframe`);
      }

      // example of url to load - https://securestaging.gethealthie.com/users/388687
      // can also be - https://securestaging.gethealthie.com/users/388687/Overview
      const patientID = location.href.split("/")[4];
      const iframe = generateIframe(`${routeURLs.appointments}/patient/${patientID}`);
      appointmentReplacement.append(iframe);
    } else {
      // wait for content load
      debugLog(`tampermonkey waiting appointment view on user profile`);
      createTimeout(waitAppointmentsProfile, 200);
    }
  }
}

function handleAppointmentsProfileRoute() {
  if (isStagingEnv) {
    debugLog("tampermonkey skips waitAppointmentsProfile on staging; OPEN_SCHEDULE listener opens the modal");
    return;
  }
  debugLog("tampermonkey calls waitAppointmentsProfile and addMembershipAndOnboarding");
  waitAppointmentsProfile();
}

function setupSearchResultClickInterceptor(attempt = 0) {
  const $ = waitForJQueryOrRetry(
    setupSearchResultClickInterceptor,
    attempt,
    `tampermonkey stopped waiting for jquery in search interceptor after ${attempt} attempts`,
    `tampermonkey waiting for jquery to load in search interceptor`
  );
  if (!$) {
    return;
  }

  // Extract current user ID from URL
  const currentUrl = location.href;
  if (searchInterceptorUrl === currentUrl) {
    debugLog(`tampermonkey search interceptor already set up for current URL`);
    return;
  }

  const userIdMatch = currentUrl.match(/\/users\/(\d+)/);
  if (!userIdMatch) {
    debugLog(`tampermonkey search interceptor: no user ID found in current URL`);
    return;
  }
  const currentUserId = userIdMatch[1];
  searchInterceptorUrl = currentUrl;

  debugLog(`tampermonkey setting up search result click interceptor for user ID: ${currentUserId}`);

  // Set up click interceptor using event delegation on document
  $(document)
    .off("click.tampermonkeySearchInterceptor")
    .on("click.tampermonkeySearchInterceptor", '[data-testid="view-profile"]', function (event) {
      const clickedElement = $(this);
      let targetHref = clickedElement.attr("href");

      // Also check parent elements for href if not found on clicked element
      if (!targetHref) {
        targetHref = clickedElement.closest("a").attr("href");
      }

      debugLog(`tampermonkey search interceptor: clicked view-profile with href: ${targetHref}`);

      if (targetHref) {
        // Check if the target href contains the same user ID as current page
        const targetUserIdMatch = targetHref.match(/\/users\/(\d+)/);
        if (targetUserIdMatch && targetUserIdMatch[1] === currentUserId) {
          debugLog(
            `tampermonkey search interceptor: preventing click to same user ${currentUserId}, reloading page instead`
          );

          // Prevent the default navigation
          event.preventDefault();
          event.stopPropagation();

          // Force page reload to refresh all elements
          debugLog(`tampermonkey search interceptor: reloading page`);
          location.reload();

          return false;
        } else {
          debugLog(
            `tampermonkey search interceptor: different user target (${
              targetUserIdMatch ? targetUserIdMatch[1] : "unknown"
            }), allowing normal navigation`
          );
        }
      } else {
        debugLog(`tampermonkey search interceptor: no href found on clicked element`);
      }
    });

  // Also set up interceptor for search results container to catch dynamically added elements
  const setupSearchResultsObserver = (attempt = 0) => {
    const searchResults = $('[data-testid="header-client-search-results"]');
    if (searchResults.length > 0) {
      debugLog(`tampermonkey search interceptor: found search results container`);

      // Additional click handler specifically for search results
      searchResults
        .off("click.tampermonkeySearchResults")
        .on("click.tampermonkeySearchResults", '[data-testid="view-profile"]', function (event) {
          const clickedElement = $(this);
          let targetHref = clickedElement.attr("href");

          if (!targetHref) {
            targetHref = clickedElement.closest("a").attr("href");
          }

          debugLog(`tampermonkey search results interceptor: clicked view-profile with href: ${targetHref}`);

          if (targetHref) {
            const targetUserIdMatch = targetHref.match(/\/users\/(\d+)/);
            if (targetUserIdMatch && targetUserIdMatch[1] === currentUserId) {
              debugLog(
                `tampermonkey search results interceptor: preventing click to same user ${currentUserId}, reloading page instead`
              );

              event.preventDefault();
              event.stopPropagation();
              location.reload();

              return false;
            }
          }
        });
    } else {
      scheduleRetryOrStop(
        setupSearchResultsObserver,
        attempt,
        maxSearchResultsWaitAttempts,
        1000,
        `tampermonkey stopped waiting for search results container after ${attempt} attempts`
      );
    }
  };

  // Set up the search results observer with a delay
  createTimeout(setupSearchResultsObserver, 500);

  debugLog(`tampermonkey search result click interceptor setup complete`);
}

function hideGroupNameOccurrences(attempt = 0) {
  const $ = waitForJQueryOrRetry(
    hideGroupNameOccurrences,
    attempt,
    `tampermonkey stopped waiting for jquery while hiding group names after ${attempt} attempts`
  );
  if (!$) {
    return;
  }

  const selectors = {
    sidebarGroup:
      '[data-testid="cp-section-basic-information"] div[class*="BasicInfo_basicInfo"] > div > div:nth-child(2) > div',
    clientInfoGroup:
      '.cp-tab-contents div[class*="ActionsTabClientForms_formsContainer"] div[class*="CollapsibleSection_sectionBody"] form > div:nth-child(7) > div:nth-child(2)',
    groupTab: "div#tab-groups",
    tableColumns: ".all-users table.table.users-table.users-list tr > *:nth-child(6)",
  };

  // let's also add a style element to hide the group name occurrences
  let cssRules = `
    ${selectors.sidebarGroup},
    ${selectors.clientInfoGroup},
    ${selectors.groupTab},
    ${selectors.tableColumns} {
      display: none !important;
    }
  `;
  let cssRuleToCheck = `${selectors.sidebarGroup}`;
  let styleElementExists =
    $("style").filter(function () {
      return $(this).text().indexOf(cssRuleToCheck) !== -1;
    }).length > 0;
  if (!styleElementExists) {
    let styleElement = document.createElement("style");
    styleElement.appendChild(document.createTextNode(cssRules));
    $("head").append(styleElement);
    debugLog(`tampermonkey added style element to hide group name occurrences`);
  }

  let numFound = 0;
  let maxAttempts = 25;
  let attempts = 0;

  function checkElements() {
    attempts++;
    numFound = 0;

    for (const [key, selector] of Object.entries(selectors)) {
      const elements = $(selector);
      if (elements.length > 0) {
        elements.each(function () {
          this.style.setProperty("display", "none", "important");
          this.style.setProperty("visibility", "hidden", "important");
          this.style.setProperty("opacity", "0", "important");
        });
        debugLog(`tampermonkey ${key} hidden with inline styles`);
        numFound++;
      } else {
        debugLog(`tampermonkey couldn't find ${key}`);
      }
    }

    if (numFound < Object.keys(selectors).length && attempts < maxAttempts) {
      createTimeout(checkElements, 200);
    } else if (attempts >= maxAttempts) {
      debugLog(`tampermonkey stopped checking for group elements after ${attempts} attempts`);
    }
  }

  checkElements();
}

function hideOverlay() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(hideOverlay, 200);
    return;
  } else {
    $(".overlay-dialog").remove();
    debugLog(`Tampermonkey removed overlay`);
  }
}

function showOverlay(url, style = {}) {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    hideOverlay();
    // Create overlay element
    let overlay = $("<div>").addClass("overlay-dialog").css({
      position: "fixed",
      inset: "0",
      zIndex: "999999999",
      background: "#000000d9",
      display: "flex",
      flexDirection: "column",
      placeContent: "center",
      alignItems: "center",
      justifyContent: "center",
    });
    $(overlay).on("click", function () {
      if ($(".overlay-dialog")) {
        $(".overlay-dialog").remove();
      }
    });

    // Create close button element
    let closeButton = $("<span>").addClass("close-button").html("&times;").css({
      position: "absolute",
      right: "1rem",
      top: "1rem",
      color: "#fff",
      fontSize: "2.5rem",
      cursor: "pointer",
    });
    $(closeButton).on("click", function () {
      if ($(".overlay-dialog")) {
        $(".overlay-dialog").remove();
      }
    });
    overlay.append(closeButton);

    // Create dialog body element with iframe
    let dialogBody = $("<div>")
      .addClass("dialog-body")
      .css({
        background: "#fff",
        maxWidth: "max(600px, 60vw)",
        width: "100vw",
        height: "80vh",
        height: "80dvh",
        overflowY: "scroll",
        ...style,
      });

    let iframe = generateIframe(url, style);
    dialogBody.append(iframe); // Append iframe to dialog body
    overlay.append(dialogBody); // Append dialog body to overlay
    const existingOverlay = $(".body").find(".overlay-dialog");

    if (existingOverlay.length === 0) {
      $("body").append(overlay); // Append overlay to body
      debugLog(`Tampermonkey displayed overlay`);
    }
  }
}

// Staging Add Appointment posts { type: "OPEN_SCHEDULE", patientId }. Prod uses waitAppointmentsProfile.
const MISHA_POSTMESSAGE_ORIGINS = [
  "https://misha.vorihealth.com",
  "https://qa.misha.vori.health",
  "http://localhost:3005",
];

function setupMishaPostMessageListener() {
  window.addEventListener("message", function (event) {
    if (!MISHA_POSTMESSAGE_ORIGINS.includes(event.origin)) {
      return;
    }
    const data = event.data;
    if (data?.type !== "OPEN_SCHEDULE") {
      return;
    }
    const patientId = data.patientId;
    if (!patientId || typeof patientId !== "string" || !/^\d+$/.test(patientId)) {
      debugLog("tampermonkey OPEN_SCHEDULE: invalid or missing patientId", patientId);
      enqueueDatadogLog("warn", "misha-message", "rejected OPEN_SCHEDULE invalid patientId");
      return;
    }
    enqueueDatadogLog("info", "misha-message", "received OPEN_SCHEDULE");
    showOverlay(`${routeURLs.schedule}/${patientId}`, styles.scheduleOverlay);
  });
}

function showBothCalendars(clonedCalendar, ogCalendar) {
  clonedCalendar.css({
    position: "absolute",
    transform: "translate(-46%, 35px)",
    left: "0px",
    width: "67%",
    maxWidth: "750px",
    background: "rgb(255, 255, 255)",
  });
  let cssRules = `
          .rbc-time-content>.rbc-time-gutter {
            display: none;
          }
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.cloned-calendar > div:nth-child(2),
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.cloned-calendar > div:nth-child(8),
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.og-calendar > div:nth-child(2),
          #big-calendar-container-id > div > div.rbc-time-view > div.rbc-time-content.og-calendar > div:nth-child(8) {
            display: none;
          }
          .rbc-time-content.cloned-calendar::before,
          .rbc-month-view.cloned-calendar::before {
            content: "Clone";
            position: absolute;
            top: 0px;
            background: #4caf50d1;
            font-size: 40px;
            line-height: 1.5;
            font-weight: bold;
            text-transform: uppercase;
            color: #000;
            z-index: 99999999;
          }
        `;
  let cssRuleToCheck = ".rbc-time-content.cloned-calendar::before";
  let styleElementExists =
    $("style").filter(function () {
      return $(this).text().indexOf(cssRuleToCheck) !== -1;
    }).length > 0;
  if (!styleElementExists) {
    let styleElement = document.createElement("style");
    styleElement.appendChild(document.createTextNode(cssRules));
    $("head").append(styleElement);
  }

  ogCalendar.css({
    position: "absolute",
    transform: "translate(54%, 35px)",
    border: "4px solid rgb(255, 92, 92)",
    zIndex: "9",
    width: "63%",
    background: "#fff",
  });
  cssRules = `
          .rbc-time-content.og-calendar::before,
          .rbc-month-view.og-calendar::before {
            content: "Original";
            position: absolute;
            top: 0px;
            background: #ff3232d1;
            font-size: 40px;
            line-height: 1.5;
            font-weight: bold;
            text-transform: uppercase;
            color: #000;
            z-index: 99999999;
          }
        `;
  cssRuleToCheck = ".rbc-time-content.og-calendar::before";
  styleElementExists =
    $("style").filter(function () {
      return $(this).text().indexOf(cssRuleToCheck) !== -1;
    }).length > 0;
  if (!styleElementExists) {
    let styleElement = document.createElement("style");
    styleElement.appendChild(document.createTextNode(cssRules));
    $("head").append(styleElement);
  }
}

function initSidebarCalendar() {
  let ogSdbrCalendar = $(".react-datepicker__month-container");
  let sidebarTimeout = null;
  if (!ogSdbrCalendar.length) {
    debugLog(`Tampermonkey waiting for sidebar calendar`);
    sidebarTimeout = createTimeout(initSidebarCalendar, 200);
    return;
  } else {
    debugLog(`Tampermonkey found sidebar calendar`);
    clearMyTimeout(sidebarTimeout);
    // create style element to disable pointer events on calendar
    let cssRules = `
          .react-datepicker__month-container {
            pointer-events: none;
            user-select: none;
          }
          .react-datepicker__navigation {
            pointer-events: none;
            user-select: none;
          }
        `;
    let cssRuleToCheck = ".react-datepicker__month-container";
    let styleElementExists =
      $("style").filter(function () {
        return $(this).text().indexOf(cssRuleToCheck) !== -1;
      }).length > 0;
    if (!styleElementExists) {
      let styleElement = document.createElement("style");
      styleElement.appendChild(document.createTextNode(cssRules));
      $("head").append(styleElement);
    }
  }
}

function initCalendar(replaceCalendar) {
  const $ = initJQuery();
  if (!$) {
    debugLog(`Tampermonkey jQuery not loaded, will retry initCalendar`);
    createTimeout(() => initCalendar(replaceCalendar), 200);
    return;
  }

  // Clear any previous attempts if we're forcing a replace
  if (replaceCalendar) {
    $(".cloned-calendar").remove();
    debugLog("tampermonkey force replace: removed existing cloned calendar");
  }

  // Guard Clause: If already cloned and not forcing a replace, do nothing.
  if ($(".main-calendar-column").find(".cloned-calendar").length > 0) {
    debugLog("tampermonkey calendar already cloned. Exiting.");
    return;
  }

  // Guard Clause: Check for availability tab
  let activeTab = $(".calendar-tabs .tab-item.active");
  if (activeTab && activeTab.text().toLowerCase().includes("availability")) {
    debugLog("tampermonkey on availability tab. Exiting calendar clone.");
    return;
  }

  // Handle loading state
  const calendarLoading = $(".day-view.is-loading, .week-view.is-loading, .month-view.is-loading");
  if (calendarLoading.length > 0) {
    debugLog("tampermonkey calendar is loading. Will retry when DOM updates.");
    return;
  }

  // Find the original calendar element to clone
  let ogCalendar = null;
  let calendarType = "";
  const dayWeekMonthDropdown = $('[data-testid="calendar-format-dropdown"]');
  if (!dayWeekMonthDropdown.length) {
    debugLog("tampermonkey: calendar format dropdown not found. Will retry...");
    createTimeout(() => initCalendar(replaceCalendar), 200);
    return;
  }

  const dropDownCalendarText = dayWeekMonthDropdown.text().toLowerCase();
  if (dropDownCalendarText.includes("day") || dropDownCalendarText.includes("week")) {
    ogCalendar = $("#big-calendar-container-id .rbc-time-content:not(.cloned-calendar)").first();
    calendarType = "time";
  } else if (dropDownCalendarText.includes("month")) {
    ogCalendar = $("#big-calendar-container-id .rbc-month-view:not(.cloned-calendar)").first();
    calendarType = "month";
  }

  // If no original calendar found, exit. The observer will try again.
  if (!ogCalendar || ogCalendar.length === 0) {
    debugLog(
      `tampermonkey did not find original calendar to clone (view: ${dropDownCalendarText}). Will wait for DOM update.`
    );
    return;
  }

  debugLog(`tampermonkey found original ${calendarType} calendar to clone.`, ogCalendar[0]);

  // Perform the clone, append it, and hide the original
  ogCalendar.addClass("og-calendar");
  let clonedCalendar = ogCalendar.clone(true); // `true` is essential for copying data and events
  clonedCalendar.addClass("cloned-calendar").removeClass("og-calendar").removeAttr("style");

  let cssRules = `
        .rbc-calendar { position: relative; }
        .cloned-calendar { position: absolute; top: 64px; width: 100.8%; background: #fff; z-index: 10; }
        .cloned-calendar.rbc-month-view { top: 60px; }
    `;
  let cssRuleToCheck = ".cloned-calendar";
  if (!$("style").filter((_, el) => $(el).text().includes(cssRuleToCheck)).length) {
    $("head").append($("<style>").text(cssRules));
  }

  ogCalendar.parent().append(clonedCalendar);
  debugLog("tampermonkey appended cloned calendar to parent.", ogCalendar.parent()[0]);

  !debug && ogCalendar.css({ display: "none" });
  if (debug) showBothCalendars(clonedCalendar, ogCalendar);

  // Verify clone and attach our custom event handlers
  if (clonedCalendar.length > 0) {
    debugLog("tampermonkey CLONE SUCCESSFUL. Attaching event handlers.");

    // Event listener for creating a new appointment on an empty slot
    clonedCalendar
      .find(".rbc-time-slot, .rbc-day-bg")
      .off("click")
      .on("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showOverlay(`${routeURLs.schedule}`, styles.scheduleOverlay);
        return false;
      });

    // Event listener for viewing an existing appointment
    clonedCalendar
      .find(".rbc-event.calendar-event")
      .off("click")
      .on("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const dataForValue = $(this).attr("data-tooltip-id");
        if (dataForValue) {
          const parts = dataForValue.split("__");
          if (parts.length > 1) {
            const apptUuid = parts[1].split("_")[0];
            debugLog(`tampermonkey opening appointment details for ID: ${apptUuid}`);
            showOverlay(`${routeURLs.appointment}/${apptUuid}`, styles.appointmentDetailsOverlay);
          } else {
            debugLog("Could not parse appointment ID from data-tooltip-id:", dataForValue);
          }
        } else {
          debugLog("Clicked calendar event is missing data-tooltip-id attribute");
        }
        return false;
      });

    // Initialize other components that rely on the calendar being present
    initSidebarCalendar();
    initAddButton();
    initCalendarHeaderBtns();
  } else {
    debugLog("tampermonkey CLONE FAILED. Cloned element has length 0 after append.");
    ogCalendar.removeClass("og-calendar");
  }
}

function initAddButton() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    // Locate main calendar container
    const mainCalendarContainer = $(".main-calendar-container");

    if (!mainCalendarContainer.length) {
      debugLog(`tampermonkey waiting for Main Calendar Container`);
      createTimeout(waitAddAppointmentsBtn, 200);
    } else {
      let activeTab = $(".calendar-tabs .tab-item.active");
      let availabilitiesTab = activeTab && activeTab.text().toLowerCase().includes("availability");

      if (availabilitiesTab) {
        debugLog(`Tampermonkey calendar is on availability tab - nothing to do here`);
        return;
      }

      // Locate appointment button
      debugLog(`tampermonkey locate +Add appointment btn`);
      const addAppointmentBtnElements = $('.main-calendar-container [data-testid="primaryButton"]');
      const addAppointmentBtn = addAppointmentBtnElements[0];

      if (addAppointmentBtn) {
        debugLog(`tampermonkey show overlay on +Add appointment btn`);
        let clonedBtn = $(addAppointmentBtn).clone();
        $(addAppointmentBtn).replaceWith(clonedBtn);
        clonedBtn.on("click", function (e) {
          e.stopPropagation();
          //https://qa.misha.vori.health/schedule/
          showOverlay(`${routeURLs.schedule}`, styles.scheduleOverlay);
        });
      } else {
        debugLog(`tampermonkey waiting for add appointment button`);
        createTimeout(waitAddAppointmentsBtn, 200);
      }
    }
  }
}

function initCalendarHeaderBtns() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(showOverlay, 200);
    return;
  } else {
    debugLog(`tampermonkey calendar initializing today, prev, next buttons`);
    let activeTab = $(".calendar-tabs .tab-item.active");
    let availabilitiesTab = activeTab && activeTab.text().toLowerCase().includes("availability");

    if (availabilitiesTab) {
      debugLog(`Tampermonkey calendar is on availability tab - nothing to do here`);
      return;
    }

    // Locate main calendar container
    const mainCalendarContainer = $(".main-calendar-container");

    if (!mainCalendarContainer.length) {
      debugLog(`tampermonkey waiting for Main Calendar Container`);
      createTimeout(waitAddAppointmentsBtn, 200);
    } else {
      // Locate Calendar Day-Week-Month Dropdown
      const dayWeekMonthDropdown = $('[data-testid="calendar-format-dropdown"]');
      if (dayWeekMonthDropdown.length) {
        debugLog(`tampermonkey calendar dropdown is located`);
        // Removing cloned calendar on dropdown change
        const dropDownText = dayWeekMonthDropdown[0].innerText;
        if (dropDownText === "Day") {
          debugLog(`tampermonkey - clicked on day. Removing cloned calendar...`);
          setTimeout(() => {
            $(".rbc-month-view").remove();
          }, 1000);
        } else if (dropDownText === "Week") {
          debugLog(`tampermonkey - clicked on week. Removing cloned calendar...`);
          setTimeout(() => {
            $(".rbc-month-view").remove();
          }, 1000);
        } else if (dropDownText === "Month") {
          debugLog(`tampermonkey - clicked on month. Removing cloned calendar...`);
          setTimeout(() => {
            $(".rbc-time-content").remove();
          }, 1000);
        }
      } else {
        debugLog(`tampermonkey waiting for Day-Week-Month Dropdown`);
        createTimeout(initCalendarHeaderBtns, 200);
      }

      // Locate Today, prevBtn, nextBtn  group
      let todayBtn = $('[data-testid="today"]')[0];
      let prevBtn = $('[data-testid="goBack"]')[0];
      let nextBtn = $('[data-testid="goNext"]')[0];

      if (todayBtn && prevBtn && nextBtn) {
        debugLog(`tampermonkey Today, prevBtn, nextBtn are located`);
        $(todayBtn).on("click", function (e) {
          debugLog(`tampermonkey - clicked on today. Re-initializing calendar...`);
          initCalendar(true);
        });
        $(prevBtn).on("click", function (e) {
          debugLog(`tampermonkey - clicked on prev. Re-initializing calendar...`);
          initCalendar(true);
        });
        $(nextBtn).on("click", function (e) {
          debugLog(`tampermonkey - clicked on next. Re-initializing calendar...`);
          initCalendar(true);
        });
      } else {
        debugLog(`tampermonkey waiting for add today, <, > button`);
        createTimeout(initCalendarHeaderBtns, 200);
      }
    }
  }
}

let calendarInitialized = false;
function waitCalendar() {
  if (!calendarInitialized) {
    initCalendar();
    calendarInitialized = true;
  }
}

function waitAddAppointmentsBtn() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey jquery not loaded`);
    createTimeout(waitAddAppointmentsBtn, 200);
    return;
  } else {
    initAddButton();
  }
}

function waitGoalTab(attempt = 0) {
  //check to see if the care plan tab contents has loaded
  const goals_tab = document.querySelector('[data-testid="tab-goals"]');
  if (goals_tab) {
    debugLog(`tampermonkey found goals tab`);
    goals_tab.remove();
    return;
  }
  scheduleRetryOrStop(
    waitGoalTab,
    attempt,
    maxWaitAttempts,
    200,
    `tampermonkey stopped waiting for goals tab after ${attempt} attempts`,
    `tampermonkey waiting goals tab`
  );
}

function isPediatric(dobString) {
  const dob = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();

  // Adjust if birthday hasn't occurred yet this year
  const hasBirthdayPassed =
    today.getMonth() > dob.getMonth() || (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());

  if (!hasBirthdayPassed) {
    age--;
  }
  return age < 18;
}

function loadPediatricBanner(attempt = 0) {
  // find patient DOB
  const $ = waitForJQueryOrRetry(
    loadPediatricBanner,
    attempt,
    `tampermonkey stopped waiting for jquery while loading pediatric banner after ${attempt} attempts`
  );
  if (!$) {
    return;
  }

  const basicInfo = $('[data-testid="cp-section-basic-information"]');
  if (basicInfo.length > 0) {
    const dob = $('[data-testid="client-dob"]').text();
    if (dob.length > 0) {
      const isPatientPediatric = isPediatric(dob);
      const pediatricBanner = $(".pediatric-banner");
      const mainContent = $(".scrollbars");

      if (isPatientPediatric && !pediatricBanner.length) {
        // insert pediatric label
        const searchBarHeader = $("#main-layout__header");
        $('<div class="pediatric-banner">PEDIATRIC</div>')
          .css({
            backgroundColor: "#EDF4FB",
            color: "#457AC8",
            fontWeight: "700",
            marginTop: "60px",
            padding: "12px 24px",
          })
          .insertAfter(searchBarHeader);

        // adjust spacing of the next element, if Pediatric banner is inserted
        mainContent.css({ marginTop: "0px" });
      } else if (!isPatientPediatric && pediatricBanner.length) {
        pediatricBanner.remove();
        mainContent.css({ marginTop: "60px" });
      }
    } else {
      scheduleRetryOrStop(
        loadPediatricBanner,
        attempt,
        maxWaitAttempts,
        200,
        `tampermonkey stopped waiting for patient DOB after ${attempt} attempts`
      );
    }
  } else {
    scheduleRetryOrStop(
      loadPediatricBanner,
      attempt,
      maxWaitAttempts,
      200,
      `tampermonkey stopped waiting for basic patient information after ${attempt} attempts`
    );
  }
}

function waitCarePlan() {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(waitCarePlan, 200);
  } else {
    //check to see if the care plan tab contents has loaded
    const cpTabContents = $(".cp-tab-contents");
    if (cpTabContents.length > 0) {
      // handle edge case: clicking on careplan tab multiple times
      const careplanTabBtn = $('a[data-testid="careplans-tab-btn"]');
      careplanTabBtn.on("click", handleCarePlanTabClick);

      function handleCarePlanTabClick() {
        if (location.href.includes("all_plans")) {
          waitCarePlan();
        }
      }
      removeCareplan();
    } else {
      //wait for content load
      debugLog(`tampermonkey waiting for careplan tab`);
      createTimeout(waitCarePlan, 200);
    }
  }
}

function waitEditChartingNote(attempt = 0) {
  const $ = waitForJQueryOrRetry(
    waitEditChartingNote,
    attempt,
    `tampermonkey stopped waiting for jquery on chart note edit after ${attempt} attempts`
  );
  if (!$) {
    return;
  } else {
    // Wait for side bar patient profile to load
    const quickProfileTabContent = $("#quick-profile-core-content");
    if (quickProfileTabContent.length) {
      // Hide display of last and next appointment
      hideChartingNotesAppointment();

      // add onclick event to General tab
      const generalTabBtn = $('[class*="TabsComponent_tab"], .TabsComponent_tab__2x4Tz');
      generalTabBtn.off("click.tampermonkeyChartNote").on("click.tampermonkeyChartNote", function () {
        createTimeout(waitEditChartingNote, 0);
      });
      // add onclick event to QuickProfile btn
      const quickProfileBtn = $('[class*="PrivateNotesHeader_quickProfile"], .PrivateNotesHeader_quickProfile__kRq1v');
      quickProfileBtn.off("click.tampermonkeyChartNote").on("click.tampermonkeyChartNote", function () {
        createTimeout(waitEditChartingNote, 0);
      });
      if (patientGroupName === "") {
        // Add loading text until group name is loaded
        addGroupNameContent("Loading...");
        // load invisible iframe for getPatientInfo to determine group name
        const url = location.href;
        patientNumber = url.split("/")[url.split("/").indexOf("users") + 1];
        let iframe = generateIframe(`getPatientInfo?id=${patientNumber}`, {
          position: "absolute",
          height: "0px",
          width: "0px",
          border: "0px",
        });
        // append to document body
        $(quickProfileTabContent).append(iframe);
      } else {
        addGroupNameContent(patientGroupName);
      }
    } else {
      scheduleRetryOrStop(
        waitEditChartingNote,
        attempt,
        maxWaitAttempts,
        200,
        `tampermonkey stopped waiting for quick profile after ${attempt} attempts`
      );
    }
  }
}

function addGroupNameContent(groupName) {
  const groupNameSpan = document.querySelector('[data-tooltip-id="quick-profile-user-group__tooltip"]');
  if (groupNameSpan) {
    groupNameSpan.textContent = groupName;
  }
}

function removeCareplan() {
  const $ = initJQuery();
  const parent = $(".cp-tab-contents");
  patientNumber = location.href.split("/")[location.href.split("/").length - 2];
  let iframe = generateIframe(`${patientNumber}/${routeURLs.careplan}`, {
    className: "cp-tab-contents",
  });
  const loading_container = document.querySelector('[data-testid="loading-state-container"]');
  if (loading_container) {
    createTimeout(waitCarePlan, 200);
  } else {
    const careplan_sec = document.querySelector('[data-testid="no-care-plans-wrapper"]');
    const careplan_sec2 = document.querySelector('[class^="AllCarePlans_carePlansWrapper"]');
    let to_remove = careplan_sec;
    if (!careplan_sec) {
      to_remove = careplan_sec2;
    }
    if (to_remove) {
      to_remove.remove();
      parent.append(iframe);
      carePlanLoopLock = carePlanLoopLock + 1;
    } else {
      createTimeout(waitCarePlan, 200);
    }
  }
}

function rescheduleAppointment(appointmentID) {
  showOverlay(`${routeURLs.schedule}/${appointmentID}`, styles.scheduleOverlay);
}

function handleCarePlanTmInput(carePlan) {
  const getGoalQuery = `query {
                    goals(user_id: "${patientNumber}", per_page: 100) {
                      id,
                      name
                    }
                  }
                  `;
  const getGoalPayload = JSON.stringify({ query: getGoalQuery });
  healthieGQL(getGoalPayload).then((response) => {
    const allGoals = response.data.goals;
    debugLog("tampermonkey all goals", response);

    allGoals.forEach((goal) => {
      const deleteGoalQuery = `mutation {
                    deleteGoal(input: {id: "${goal.id}"}) {
                      goal {
                        id
                      }

                      messages {
                        field
                        message
                      }
                    }
                  }
                  `;
      const deleteGoalPayload = JSON.stringify({
        query: deleteGoalQuery,
      });
      healthieGQL(deleteGoalPayload).then((response) => {
        debugLog("tampermonkey deleted goal", response);
      }).catch(reportHealthieRequestError);
    });

    debugLog(`tampermonkey message posted ${patientNumber} care plan status ${JSON.stringify(carePlan)}`);
    const goal = carePlan.goal.title;
    debugLog("tampermokey goal title ", goal);

    const milestones = carePlan.milestones;
    milestones.forEach((element) => {
      debugLog("tampermonkey milestone inserted", element);
      const milestoneTitle = element.title;
      if (element.isVisible) {
        const query = `mutation {
                                  createGoal(input: {
                                    name: "${milestoneTitle}",
                                    user_id: "${patientNumber}",
                                    repeat: "Once"
                                  }) {
                                    goal {
                                      id
                                    }
                                    messages {
                                      field
                                      message
                                    }
                                  }
                                }
                                `;
        const payload = JSON.stringify({ query });
        submitHealthieGoal(payload);
      }
    });

    const query = `mutation {
                          createGoal(input: {
                            name: "${goal}",
                            user_id: "${patientNumber}",
                            repeat: "Once"
                          }) {
                            goal {
                              id
                            }
                            messages {
                              field
                              message
                            }
                          }
                        }
                        `;
    const payload = JSON.stringify({ query });
    submitHealthieGoal(payload);

    const tasks = carePlan.tasks.tasks;
    debugLog("tampermonkey tasks are ", tasks);
    tasks.forEach((element) => {
      debugLog("tampermonkey task is ", element);
      if (element.contentfulId == "6nJFhYE6FJcnWLc3r1KHPR") {
        debugLog("tampermonkey motion guide assigned");
        element.items[0].exercises.forEach((element) => {
          debugLog("tampermonkey", element);
          const name = element.contentfulEntityId + " - " + element.side;
          const query = `mutation {
                                  createGoal(input: {
                                    name: "${name}",
                                    user_id: "${patientNumber}",
                                    repeat: "Daily"
                                  }) {
                                    goal {
                                      id
                                    }
                                    messages {
                                      field
                                      message
                                    }
                                  }
                                }
                                `;
          const payload = JSON.stringify({ query });
          submitHealthieGoal(payload);
        });
      } else if (element.isVisible) {
        debugLog("tampermonkey regular task assigned");
        const query = `mutation {
                                  createGoal(input: {
                                    name: "${element.title}",
                                    user_id: "${patientNumber}",
                                    repeat: "Daily"
                                  }) {
                                    goal {
                                      id
                                    }
                                    messages {
                                      field
                                      message
                                    }
                                  }
                                }
                                `;
        const payload = JSON.stringify({ query });
        submitHealthieGoal(payload);
      }
    });
  }).catch(reportHealthieRequestError);
}

function handleRescheduleOrReload(data) {
  if (data.reschedule !== undefined || data.reload !== undefined) {
    rescheduleAppointment(data.reschedule);
  }
  if (data.reload !== undefined) {
    window.location.reload();
  }
}

function handleNewChartNoteId(newChartNoteId) {
  debugLog("tampermonkey navigating to new charting note", newChartNoteId);
  window.top.location.href = `https://${healthieURL}/users/${
    newChartNoteId.split("-")[1]
  }/private_notes/edit/${newChartNoteId.split("-")[0]}`;
}

function handleVerifyStatusMessages(data) {
  if (data.isEmailVerified !== undefined) {
    debugLog("tampermonkey is email verified", data.isEmailVerified);
    isEmailVerified = data.isEmailVerified;
    !isEmailVerified && verifyEmailPhoneButtons(true);
  }
  if (data.isPhoneNumberVerified !== undefined) {
    debugLog("tampermonkey is phone verified", data.isPhoneNumberVerified);
    isPhoneNumberVerified = data.isPhoneNumberVerified;
    !isPhoneNumberVerified && verifyEmailPhoneButtons(false);
  }
  if (data.loading !== undefined) {
    debugLog("tampermonkey loading", data.loading);
    isLoadingEmailPhone = data.loading ? true : false;
  }
}

function handleBasicInformationHeight(rawHeight) {
  debugLog("tampermonkey received basicInformationHeight event", rawHeight);
  const height = typeof rawHeight === "string" ? parseInt(rawHeight, 10) : rawHeight;
  const currentPatientNumber = location.href.split("/")[4];
  if (currentPatientNumber && !Number.isNaN(height)) {
    updatePatientStatusIframeHeight(currentPatientNumber, height);
  } else {
    debugLog("tampermonkey could not determine patient number or invalid height", {
      patientNumber: currentPatientNumber,
      height: height,
    });
  }
}

function handleMishaWindowMessage(event) {
  if (!MISHA_POSTMESSAGE_ORIGINS.includes(event.origin)) {
    return;
  }
  const data = event.data;
  if (!data) {
    return;
  }
  debugLog("tampermonkey received misha event", event, "event.data", data);
  noteMishaMessage(data);
  if (data.tmInput !== undefined && patientNumber === "") {
    enqueueDatadogLog("warn", "misha-message", "rejected tmInput without patient");
  }
  if (data.tmInput !== undefined && patientNumber !== "") {
    handleCarePlanTmInput(data.tmInput);
  }
  handleRescheduleOrReload(data);
  if (data.closeWindow !== undefined) {
    hideOverlay();
  }
  if (data.patientProfile !== undefined) {
    debugLog("tampermonkey navigating to patient profile", data.patientProfile);
    GM_openInTab(`https://${healthieURL}/users/${data.patientProfile}`);
  }
  if (data.newChartNoteId !== undefined) {
    handleNewChartNoteId(data.newChartNoteId);
  }
  if (data.patientGroupName !== undefined) {
    debugLog("tampermonkey replace patientGroupName content", data.patientGroupName);
    patientGroupName = data.patientGroupName;
    addGroupNameContent(data.patientGroupName);
  }
  handleVerifyStatusMessages(data);
  if (data.healthieActionsTab !== undefined) {
    debugLog("tampermonkey navigating to patient actions tab", data.healthieActionsTab);
    const patientId = data.healthieActionsTab;
    window.open(`https://${healthieURL}/users/${patientId}/actions`, "_top");
  }
  if (data.verifyEmail !== undefined) {
    debugLog("tampermonkey received verifyEmail event", data.verifyEmail);
    const { patientId, email } = data.verifyEmail;
    const verifyOverlayURL = `${routeURLs.otpVerify}?id=${patientId}&email=${encodeURIComponent(email)}`;
    showOverlay(verifyOverlayURL, styles.otpOverlay);
  }
  if (data.verifyPhone !== undefined) {
    debugLog("tampermonkey received verifyPhone event", data.verifyPhone);
    const { patientId, phone } = data.verifyPhone;
    const verifyOverlayURL = `${routeURLs.otpVerify}?id=${patientId}&phone=${encodeURIComponent(phone)}`;
    showOverlay(verifyOverlayURL, styles.otpOverlay);
  }
  if (data.basicInformationHeight !== undefined) {
    handleBasicInformationHeight(data.basicInformationHeight);
  }
}

function waitForMishaMessages() {
  window.onmessage = handleMishaWindowMessage;
}

function waitSettingsAPIpage() {
  //check to see if the care plan tab contents has loaded
  if (document.querySelector(".api_keys")) {
    debugLog(`tampermonkey found api keys section`);
    // Check if the api-keys-wrapper already exists
    let existingWrapper = document.querySelector(".api-keys-wrapper.vori");
    let newButton;
    let newInput;

    if (!existingWrapper) {
      // Create the new elements
      let newWrapper = document.createElement("div");
      newWrapper.classList.add("api-keys-wrapper", "vori");
      newWrapper.style.marginTop = "2rem";
      newWrapper.style.paddingBottom = "2rem";
      newWrapper.style.borderBottom = "1px solid #e0e0e0";
      newWrapper.style.marginRight = "28px";

      let newHeader = document.createElement("div");
      newHeader.classList.add("api-keys-header");
      newHeader.textContent = "Connect to Vori Health";
      newHeader.style.height = "44px";
      newHeader.style.color = "#16284a";
      newHeader.style.fontFamily = '"Avenir",Helvetica,"Arial",sans-serif';
      newHeader.style.fontWeight = "800";
      newHeader.style.fontSize = "28px";
      newHeader.style.lineHeight = "34px";
      newHeader.style.letterSpacing = "-.02em";

      let inputButtonWrapper = document.createElement("div");
      inputButtonWrapper.classList.add("api-keys-input-button-wrapper");
      inputButtonWrapper.style.display = "flex";
      inputButtonWrapper.style.justifyContent = "space-between";
      inputButtonWrapper.style.width = "100%";

      newInput = document.createElement("input");
      newInput.setAttribute("type", "text");
      newInput.setAttribute("placeholder", "Enter your API key here");
      newInput.classList.add("api-key-input");
      newInput.style.height = "38px";
      newInput.style.width = "100%";
      newInput.style.maxWidth = "292px";
      newInput.style.padding = "0 14px";
      newInput.style.borderRadius = "4px";
      newInput.style.border = "1px solid #828282";

      newButton = document.createElement("button");
      newButton.setAttribute("type", "button");
      newButton.textContent = "Link API key";
      newButton.style.backgroundColor = "#4a90e2";
      newButton.style.color = "#fff";
      newButton.style.border = "1px solid #4a90e2";
      newButton.style.padding = "8px 10px";
      newButton.style.fontFamily = '"Avenir",Helvetica,"Arial",sans-serif';
      newButton.style.fontSize = "14px";
      newButton.style.lineHeight = "20px";
      newButton.style.width = "200px";
      newButton.style.borderRadius = "3px";
      newButton.style.cursor = "pointer";

      // Append the new elements to the existing container
      let mainContainer = document.querySelector(".main-settings__container");
      mainContainer.appendChild(newWrapper);

      // Append the new elements to the new wrapper
      newWrapper.appendChild(newHeader);
      newWrapper.appendChild(inputButtonWrapper);
      inputButtonWrapper.appendChild(newInput);
      inputButtonWrapper.appendChild(newButton);
    } else {
      newButton = existingWrapper.querySelector("button");
      newInput = existingWrapper.querySelector("input");
    }

    let storedApiKey = GM_getValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", ""); // Retrieve the stored API key using GM_getValue

    if (storedApiKey === "") {
      newInput.value = storedApiKey; // Set the initial value of the input
    } else {
      newInput.value = "***************"; // show mask indicating that a valid key is stored
    }

    // Add onclick handler to the "Link Api key" button
    newButton.onclick = function () {
      let apiKey = newInput.value.trim(); // Trim whitespace from the input value
      if (apiKey === "") {
        enqueueDatadogLog("warn", "api-key", "rejected empty key");
        alert("Please enter a valid API key!");
      } else {
        const patientNumber = location.href.split("/")[location.href.split("/").length - 2];
        healthieAPIKey = apiKey;
        auth = `Basic ${healthieAPIKey}`;

        // let's check that we can get goals successfully
        const getGoalQuery = `query {
                              goals {
                                id
                                name
                              }
                            }
                            `;
        const getGoalPayload = JSON.stringify({ query: getGoalQuery });
        healthieGQL(getGoalPayload).then((response) => {
          debugLog(`tampermonkey api key goals response: ${JSON.stringify(response)}`);

          if (response.errors) {
            enqueueDatadogLog("warn", "api-key", "validation failed errors=" + response.errors.length);
            alert("That is not a valid API key. Please verify the key and try again.");
          } else {
            GM_setValue(isStagingEnv ? "healthieStagingApiKey" : "healthieApiKey", apiKey);
            enqueueDatadogLog("info", "api-key", "saved");
            flushDatadogLogsNow();
            alert("API key saved successfully!");
            createTimeout(null, 2000);
            window.location.reload();
          }
        }).catch((error) => {
          reportHealthieRequestError(error);
          alert("Unable to verify the API key. Please try again.");
        });
      }
    };
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting for api keys section`);
    createTimeout(waitSettingsAPIpage, 200);
  }
}

function isAPIconnected(attempt = 0) {
  //check to see if the header has loaded
  if (document.querySelector(".header")) {
    let voriHeaderExists = document.querySelector(".vori-api-message");
    if (!voriHeaderExists) {
      const header = document.querySelector(".header");
      const apiMsgDiv = document.createElement("div");
      apiMsgDiv.classList.add("vori-api-message");
      apiMsgDiv.style.display = "block";
      apiMsgDiv.style.position = "relative";
      apiMsgDiv.style.background = "#e3e532";
      apiMsgDiv.style.top = "60px";
      apiMsgDiv.style.minHeight = "42px";
      apiMsgDiv.style.textAlign = "center";
      apiMsgDiv.style.padding = "10px";

      const apiMsgLink = document.createElement("a");
      apiMsgLink.textContent = "You have not connected your Healthie Account to Vori Health. Set it up here!";
      apiMsgLink.href = "/settings/api_keys";
      apiMsgLink.style.color = "#333";
      apiMsgLink.style.fontSize = "15px";
      apiMsgLink.style.letterSpacing = "0.3px";
      apiMsgLink.style.textDecoration = "none";

      function addHoverEffect() {
        apiMsgLink.style.textDecoration = "underline";
      }

      function removeHoverEffect() {
        apiMsgLink.style.textDecoration = "none";
      }

      apiMsgDiv.appendChild(apiMsgLink);

      if (healthieAPIKey === "") {
        apiMsgDiv.style.display = "block";
        apiMsgLink.addEventListener("mouseover", addHoverEffect);
        apiMsgLink.addEventListener("mouseout", removeHoverEffect);
      } else {
        apiMsgDiv.style.display = "none";
        apiMsgLink.removeEventListener("mouseover", addHoverEffect);
        apiMsgLink.removeEventListener("mouseout", removeHoverEffect);
      }

      header.insertAdjacentElement("afterend", apiMsgDiv);
    }
  } else {
    scheduleRetryOrStop(
      isAPIconnected,
      attempt,
      maxWaitAttempts,
      200,
      `tampermonkey stopped waiting for header after ${attempt} attempts`,
      `tampermonkey waiting for header`
    );
  }
}

function showInstructions() {
  if (document.querySelector(".api-keys-wrapper") && document.querySelector(".api-keys-input-button-wrapper")) {
    const apiKeyInputContainer = document.querySelector(".api-keys-input-button-wrapper");

    if (healthieAPIKey === "") {
      const instructions = document.createElement("p");
      instructions.innerHTML =
        "<b>Vori Health Instructions</b><br />" +
        '1. Click the button below that says <i>"Add API Key"</i><br />' +
        '2. Enter a memorable name in the <i>API Key Name</i> field then click on "Create API Key"<br />' +
        "3. The API Key should now be listed below. Copy the text under the <i>Key</i> column.<br />" +
        '4. Now under the "Connect to Vori Health" section, paste the key in the box that says <i>Enter your API Key here</i>, and then select the "Link Api key" button.<br />' +
        '5. You should see a message saying "API key saved successfully"<br />';
      instructions.classList.add("vori-instruction-message");
      instructions.style.display = "block";
      instructions.style.position = "relative";
      instructions.style.background = "rgb(227 229 50 / 35%)";
      instructions.style.color = "#16284a";
      instructions.style.minHeight = "42px";
      instructions.style.padding = "10px";
      instructions.style.marginTop = "14px";

      apiKeyInputContainer.insertAdjacentElement("afterend", instructions);
    }
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting to show instructions`);
    createTimeout(showInstructions, 200);
  }
}

function setGeneralTab() {
  let generalTab = document.querySelector('[data-testid="activetab-general"]');
  debugLog(`tampermonkey general tab is`, generalTab);
  generalTab &&
    generalTab.addEventListener(
      "click",
      function () {
        debugLog(`tampermonkey clicked general tab`, generalTab);
        waitAppointmentSidebar();
        createTimeout(function () {
          setAppointmentCollapse();
        }, 600);
      },
      false
    );
}

function setAppointmentCollapse() {
  let appointmentSectionTitle = document.querySelector('[data-testid="cp-section-appointments"]');
  appointmentSectionTitle &&
    appointmentSectionTitle.addEventListener(
      "click",
      function () {
        debugLog(`tampermonkey clicked section title`, appointmentSectionTitle.className);
        appointmentSectionTitle.className != "cp-sidebar-expandable-section undefined opened" &&
          waitAppointmentSidebar();
      },
      false
    );
}

function waitInfo() {
  let infoButton = document.getElementsByClassName("right-menu-trigger is-hidden-mobile")[0];
  if (infoButton) {
    createTimeout(function () {
      setGeneralTab();
      setAppointmentCollapse();
    }, 600);
    infoButton.addEventListener(
      "click",
      function () {
        createTimeout(function () {
          let appointmentWindow = document.querySelector('[data-testid="cp-section-appointments"]');
          debugLog(`tampermonkey info clicked`, appointmentWindow);
          setGeneralTab();
          setAppointmentCollapse();
          appointmentWindow && waitAppointmentSidebar();
        }, 500);
      },
      false
    );
  } else {
    createTimeout(waitInfo, 500);
  }
}

function waitAppointmentSidebar() {
  let appointmentWindow = document.querySelector('[data-testid="cp-section-appointments"]');
  let goalsTab = document.querySelector('[data-testid="tab-goals"]');
  debugLog(`tampermonkey goals tab `, goalsTab);
  goalsTab && goalsTab.remove();
  let actionLinks = Array.from(document.getElementsByClassName("healthie-action-link"));
  if (appointmentWindow && actionLinks[0]) {
    goalsTab && goalsTab.remove();
    actionLinks.forEach((element) => {
      debugLog("tampermonkey action link found", element);
      element.remove();
    });
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting to hide chat links`);
    createTimeout(waitAppointmentSidebar, 500);
  }
}

function waitClientList() {
  const $ = initJQuery();
  let bookLinks = Array.from(document.querySelectorAll("button")).filter(
    (e) => e.textContent.toLowerCase() === "book session"
  );
  if (bookLinks.length > 0) {
    Array.from(bookLinks).forEach((element) => {
      debugLog("tampermonkey book link found", element);
      let ID = element.parentElement.getAttribute("data-testid").split("-").at(-1);
      let bookButton = $(element);
      let clonedButton = bookButton.clone(true);
      clonedButton.on("click", function (e) {
        e.stopPropagation();
        //schedule/patientid
        showOverlay(`${routeURLs.schedule}/${ID}`, styles.scheduleOverlay);
      });
      bookButton.replaceWith(clonedButton);
    });
    createTimeout(waitClientList, 500);
  } else {
    //wait for content load
    debugLog(`tampermonkey waiting to update book link`);
    createTimeout(waitClientList, 500);
  }
}

function reportHealthieRequestError(error) {
  console.error("tampermonkey Healthie request failed", error);
}

function submitHealthieGoal(payload) {
  healthieGQL(payload).catch(reportHealthieRequestError);
}

function healthieGQL(payload) {
  let response = null;
  let api_env = isStagingEnv ? "staging-api" : "api";
  response = fetch("https://" + api_env + ".gethealthie.com/graphql", {
    method: "POST",
    headers: {
      AuthorizationSource: "API",
      Authorization: auth,
      "content-type": "application/json",
    },
    body: payload,
  })
    .then((res) => res.json())
    .then((result) => {
      debugLog("tampermonkey", result);
      return result;
    });

  return response;
}

function addMembershipAndOnboarding(retryCount = 0, maxRetries = 25) {
  //get phone icon and related column - using basic info section as more stable entry point
  const basicInfoSection = document.querySelector('[data-testid="cp-section-basic-information"]');
  const phoneColumn = basicInfoSection
    ? basicInfoSection.querySelector('div[class*="BasicInfo_basicInfo"] > div > div:nth-child(1)')
    : null;
  const iframeAdded = phoneColumn ? phoneColumn.parentNode.querySelector(".misha-iframe-container") : null;

  if (phoneColumn && !iframeAdded) {
    // get the patient number from the URL
    patientNumber = location.href.split("/")[4];
    debugLog(`tampermonkey patient number`, patientNumber);
    // create iframe (generateIframe returns a jQuery object)
    //Add custom height and width to avoid scrollbars because the material ui Select component
    const iframe = generateIframe(`${routeURLs.patientStatus}/${patientNumber}`, {
      height: "520px",
      width: "105%",
      minWidth: "210px",
    });
    const iframeExists = phoneColumn.parentNode.querySelector(".misha-iframe-container");
    // add iframe after phone element, get the native DOM Node from the jQuery object, this is the first array element.
    !iframeExists && phoneColumn.parentNode.insertBefore(iframe[0], phoneColumn.nextSibling);
    debugLog(`tampermonkey successfully injected patient status iframe`);
  } else if (retryCount < maxRetries) {
    debugLog(`tampermonkey retrying addMembershipAndOnboarding in 500ms (${retryCount + 1}/${maxRetries})`);
    createTimeout(() => {
      addMembershipAndOnboarding(retryCount + 1, maxRetries);
    }, 500);
  } else {
    debugLog(`tampermonkey addMembershipAndOnboarding failed after ${maxRetries} retries`);
    noteRetryExhausted("tampermonkey stopped waiting for patient status phone column", retryCount);
  }
}

function verifyEmailPhone() {
  debugLog(`tampermonkey verifyEmailPhone`);
  let clientInfoPane = document.querySelector('[data-testid="personal-information-form"]');
  if (clientInfoPane) {
    debugLog(`tampermonkey found client info pane`);
    let saveButton = document.querySelector('[data-testid="personal-information-form-submit"]');
    debugLog(`tampermonkey save button`, saveButton);
    if (saveButton) {
      debugLog(`tampermonkey found save button`, saveButton);
      saveButton.onclick = function () {
        createTimeout(() => {
          window.location.reload();
        }, 1000);
      };
    } else {
      createTimeout(() => {
        verifyEmailPhone();
      }, 200);
    }
    let clientInfoPaneObj = clientInfoPane;
    //load invisible iframe for getPatientInfo to determine verification status of phone/email
    patientNumber = location.href.split("/")[location.href.split("/").length - 2];
    let iframe = generateIframe(`getPatientInfo?id=${patientNumber}`, {
      position: "absolute",
      height: "0px",
      width: "0px",
      border: "0px",
    });
    // append to document body
    $(clientInfoPaneObj).append(iframe);
  } else {
    createTimeout(() => {
      verifyEmailPhone();
    }, 200);
  }
}

function verifyEmailPhoneButtons(isEmail) {
  let field = isEmail ? document.querySelector('[data-testid="email-input"]') : document.getElementById("phone_number");
  let button = isEmail
    ? document.getElementById("verify-email-button")
    : document.getElementById("verify-phone-button");
  if (field && field.value != "") {
    patientNumber = location.href.split("/")[location.href.split("/").length - 2];
    let verifyOverlayURL = routeURLs.otpVerify + `?id=${patientNumber}`;
    verifyOverlayURL += isEmail
      ? `&email=${encodeURIComponent(field.value)}`
      : `&phone=${encodeURIComponent(field.value)}`;
    if (!button && field) {
      const buttonStyle = {
        background: "#026460",
        color: "white",
        borderRadius: "2px",
      };
      const buttonStyleString = Object.entries(buttonStyle)
        .map(([property, value]) => `${convertToCSSProperty(property)}: ${value};`)
        .join(" ");
      const button = $("<button>", {
        id: isEmail ? "verify-email-button" : "verify-phone-button",
        text: "Verify",
        style: buttonStyleString,
        type: "button",
        click: function () {
          enqueueDatadogLog("info", "verify", "opened " + (isEmail ? "email" : "phone") + " from healthie");
          showOverlay(verifyOverlayURL, styles.otpOverlay);
        },
      });
      field.parentNode.insertBefore(button[0], field.nextSibling);
      let containerStyle = field.parentElement.style;
      containerStyle.display = "flex";
      containerStyle.flexDirection = "row";
    }
  }
}

function observeDOMChanges(mutations, observer) {
  // handle url changes
  if (location.href !== previousUrl) {
    previousUrl = location.href;
    //reset loop flag
    carePlanLoopLock = 0;
    debugLog(`tampermonkey URL changed to ${location.href}`);
    enqueueDatadogLog("info", "navigation", "path=" + normalizePath(location.pathname));

    // Clear all timeouts
    for (let i = 0; i < timeoutIds.length; i++) {
      //debugLog(`tampermonkey clear timeout ${timeoutIds[i]}`);
      clearTimeout(timeoutIds[i]);
    }
    timeoutIds = [];
    waitForMishaMessages();
    hideGroupNameOccurrences();

    //Care plans URL
    //if (location.href.includes("/all_plans")) {

    if (urlValidation.editChartingNote.test(location.href)) {
      //Function that will check when EditChartingNote tab has loaded
      debugLog("tampermonkey calls waitEditChartingNote");
      waitEditChartingNote();

      // Set up search result click interceptor for edit charting note pages
      setupSearchResultClickInterceptor();
    }

    if (!urlValidation.editChartingNote.test(location.href) && patientGroupName !== "") {
      // Clean up patient group name when navigating off EditChartingNote tab
      patientGroupName = "";
    }

    if (urlValidation.carePlan.test(location.href)) {
      //Function that will check when care plan tab has loaded
      debugLog("tampermonkey calls waitCarePlan");
      waitCarePlan();

      // Set up search result click interceptor for care plan pages
      setupSearchResultClickInterceptor();
    }

    if (urlValidation.goals.test(location.href) && !urlValidation.editChartingNote.test(location.href)) {
      //Function that will check when goal tab has loaded
      debugLog("tampermonkey calls waitGoalTab");
      waitGoalTab();
      debugLog("tampermonkey calls loadPediatricBanner");
      loadPediatricBanner();

      // Set up search result click interceptor for goals pages
      setupSearchResultClickInterceptor();
    }

    if (urlValidation.appointmentsProfile.test(location.href)) {
      handleAppointmentsProfileRoute();

      // Set up search result click interceptor for appointment profile pages
      setupSearchResultClickInterceptor();
    }

    if (urlValidation.membership.test(location.href)) {
      addMembershipAndOnboarding();
      replaceBasicInformationSection();

      // Set up search result click interceptor for membership pages
      setupSearchResultClickInterceptor();
    }

    if (urlValidation.verifyEmailPhone.test(location.href)) {
      verifyEmailPhone();

      // Set up search result click interceptor for verify email/phone pages
      setupSearchResultClickInterceptor();
    }

    if (urlValidation.apiKeys.test(location.href)) {
      //Function to handle api keys
      debugLog("tampermonkey calls waitSettingsAPIpage and  showInstructions");
      waitSettingsAPIpage();
      showInstructions();
    }

    if (urlValidation.appointments.test(location.href)) {
      //"/appointments" ||/organization ||/providers/
      debugLog("tampermonkey calls waitAddAppointmentsBtn and waitCalendar");
      waitAddAppointmentsBtn(); //Function to handle clicking the Add appointments button
      waitCalendar(); //Function to handle clicking on empty appointment slots
    }

    if (urlValidation.appointmentsHome.test(location.href)) {
      debugLog("tampermonkey calls waitAppointmentsHome");
      waitAppointmentsHome();
    }

    if (urlValidation.conversations.test(location.href)) {
      debugLog("tampermonkey calls waitAppointmentSidebar and waitInfo");
      waitAppointmentSidebar();
      waitInfo();
    }
    if (urlValidation.clientList.test(location.href)) {
      debugLog("tampermonkey calls waitClientList");
      waitClientList();
      waitForAddPatientButton();
    }
    isAPIconnected();
  } else {
    //debugLog(`tampermonkey debug  else`);
    //if (location.href.includes("/all_plans")) {
    //carePlanLoopLock avoids triggering infinite loop
    if (carePlanLoopLock > 1 && location.href.includes("all_plans")) {
      var iframe = document.querySelector("#MishaFrame.cp-tab-contents");
      //check if Iframe doesn't exists
      if (!iframe) {
        //debugLog("tampermonkey debug The iframe does not exist");
        //reset loop flag
        carePlanLoopLock = 0;
        //Checks if goals tab exists (with a different id) and removes it.
        let goalsTab = document.querySelector('[data-testid="goals-tab-btn"]');
        debugLog(`tampermonkey goals tab `, goalsTab);
        if (goalsTab) {
          let parentDiv = goalsTab.closest("div");
          if (parentDiv) {
            parentDiv.remove();
          }
        }
        waitCarePlan();
      }
    }
  }

  // The rest
  const calendarTargetClasses = ["rbc-time-content", "rbc-month-view"];
  const homeTargetClasses = ["provider-home-content"];
  const basicInfoTargetClasses = ["cp-sidebar-expandable-section"];

  for (const mutation of mutations) {
    const { target, addedNodes, removedNodes } = mutation;

    // Check if the mutation target or any added/removed node has one of the target classes or if the children of these classes have changed
    if (
      (target && calendarTargetClasses.some((className) => target.classList.contains(className))) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) => addedNode.classList.contains(className))
        )) ||
      (removedNodes &&
        [...removedNodes].some(
          (removedNode) =>
            removedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) => removedNode.classList.contains(className))
        )) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) => addedNode.querySelector(`.${className}`))
        )) ||
      (removedNodes &&
        [...removedNodes].some(
          (removedNode) =>
            removedNode.nodeType === Node.ELEMENT_NODE &&
            calendarTargetClasses.some((className) => removedNode.querySelector(`.${className}`))
        ))
    ) {
      observer.disconnect();
      initCalendar();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      break;
    }

    if (
      (target && homeTargetClasses.some((className) => target.classList.contains(className))) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            homeTargetClasses.some((className) => addedNode.classList.contains(className))
        ))
    ) {
      observer.disconnect();
      waitAppointmentsHome();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      break;
    }

    if (
      (target && basicInfoTargetClasses.some((className) => target.classList.contains(className))) ||
      (addedNodes &&
        [...addedNodes].some(
          (addedNode) =>
            addedNode.nodeType === Node.ELEMENT_NODE &&
            basicInfoTargetClasses.some((className) => addedNode.classList.contains(className))
        ))
    ) {
      observer.disconnect();
      addMembershipAndOnboarding();
      replaceBasicInformationSection();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      break;
    }
  }
}

function hideChartingNotesAppointment(attempt = 0) {
  const $ = waitForJQueryOrRetry(
    hideChartingNotesAppointment,
    attempt,
    `tampermonkey stopped waiting for jquery while hiding chart note appointments after ${attempt} attempts`
  );
  if (!$) {
    return;
  }

  console.log(`hideChartingNotesAppointment Removing appointment tab ...`);
  $(`section[data-testid="cp-section-appointments"]`).hide();
  console.log(`Tampermonkey hideChartingNotesAppointment removed appointment tab`);
}

function validateIframeReplacement(basicInfoSection) {
  // Check if iframe exists and is the first child (full replacement mode)
  const existingIframe = basicInfoSection.find(".misha-iframe-container");
  if (existingIframe.length > 0) {
    const firstChild = basicInfoSection.children().first();
    return firstChild.hasClass("misha-iframe-container");
  }
  return false;
}

function cleanupExistingBasicInfoIframes(basicInfoSection) {
  const existingIframes = basicInfoSection.find(".misha-iframe-container");
  if (existingIframes.length > 0) {
    debugLog(`tampermonkey removing ${existingIframes.length} existing iframe(s) for mode change`);
    existingIframes.remove();
    return true;
  }
  return false;
}

function replaceBasicInformationSection(retryCount = 0) {
  debugLog(`tampermonkey replaceBasicInformationSection called - retry: ${retryCount}`);

  const $ = initJQuery();
  const maxRetries = 3;
  const currentPatientId = location.href.split("/")[4];

  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load`);
    createTimeout(() => replaceBasicInformationSection(retryCount), 200);
    return;
  }

  const basicInfoSection = $('section.cp-sidebar-expandable-section[data-testid="cp-section-basic-information"]');
  if (basicInfoSection.length === 0) {
    debugLog(`tampermonkey waiting for basic information section`);
    createTimeout(() => replaceBasicInformationSection(retryCount), 200);
    return;
  }

  debugLog(`tampermonkey found basic information section (attempt ${retryCount + 1}/${maxRetries + 1})`);

  const patientNumber = location.href.split("/")[4];
  debugLog(`tampermonkey patient number for basic info replacement`, patientNumber);

  // Check if iframe already exists and is valid
  if (validateIframeReplacement(basicInfoSection)) {
    debugLog(`tampermonkey basic info iframe already exists and is valid`);
    return;
  }

  // Clean up any existing iframes before replacing
  cleanupExistingBasicInfoIframes(basicInfoSection);

  // Full replacement mode - replace entire section with iframe
  debugLog(`tampermonkey using full replacement mode`);
  basicInfoSection.empty();

  const iframe = generateIframe(`${routeURLs.patientStatus}/${patientNumber}`, {
    height: "520px",
    width: "100%",
    border: "none",
  });

  basicInfoSection.append(iframe);

  const iframeElement = iframe.find("#MishaFrame");
  if (iframeElement.length > 0) {
    iframeElement.attr("data-patient-id", patientNumber);
    iframeElement.addClass("dynamic-height-iframe");
  }

  const success = validateIframeReplacement(basicInfoSection);
  if (success) {
    debugLog(`tampermonkey successfully replaced basic information section with patient status iframe`);
  } else {
    debugLog(`tampermonkey iframe handling failed (attempt ${retryCount + 1})`);
    if (retryCount < maxRetries && currentPatientId === location.href.split("/")[4]) {
      debugLog(`tampermonkey scheduling retry ${retryCount + 1} for basic info handling`);
      createTimeout(() => replaceBasicInformationSection(retryCount + 1), 300 * (retryCount + 1));
    } else if (retryCount >= maxRetries) {
      debugLog(`tampermonkey max retries (${maxRetries}) exceeded for basic info handling`);
      noteRetryExhausted("tampermonkey stopped replacing basic information section", retryCount);
    } else {
      debugLog(`tampermonkey patient changed during retry, aborting basic info handling`);
    }
  }
}

//observe changes to the DOM, check for URL changes
const config = { subtree: true, childList: true };
const observer = new MutationObserver(observeDOMChanges);
observer.observe(document, config);
setupMishaPostMessageListener();
setupHealthieDatadogLogs();

function updatePatientStatusIframeHeight(patientId, contentHeight) {
  const $ = initJQuery();
  if (!$) {
    debugLog(`tampermonkey waiting for jquery to load for height update`);
    createTimeout(() => updatePatientStatusIframeHeight(patientId, contentHeight), 200);
    return;
  }

  // Find the iframe for this specific patient
  const targetIframe = $(`.dynamic-height-iframe[data-patient-id="${patientId}"]`);

  if (targetIframe.length > 0) {
    // Set minimum height to prevent content from being too small
    const minHeight = 280;
    const newHeight = Math.max(contentHeight, minHeight);

    // Update iframe height
    targetIframe.css({
      height: `${newHeight + 70}px`,
      transition: "height 0.2s ease-in-out",
    });

    // Also update the container div height
    const iframeContainer = targetIframe.closest(".misha-iframe-container");
    if (iframeContainer.length > 0) {
      iframeContainer.css({
        height: `${newHeight + 70}px`,
        transition: "height 0.2s ease-in-out",
      });
    }

    // Update the basic information section
    const basicInfoSection = targetIframe.closest('section[data-testid="cp-section-basic-information"]');
    if (basicInfoSection.length > 0) {
      basicInfoSection.css({
        "min-height": `${newHeight}px`,
        transition: "min-height 0.3s ease-in-out",
      });
    }

    debugLog(`tampermonkey successfully updated heights for patient ${patientId}`);
  } else {
    debugLog(`tampermonkey could not find iframe for patient ${patientId}`);
  }
}
