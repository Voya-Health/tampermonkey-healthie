const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "careplan.js"), "utf8");
const start = source.indexOf("// Same public browser logs token");
const end = source.indexOf("const routeURLs =");

assert.notEqual(start, -1, "Datadog logging block start was not found");
assert.notEqual(end, -1, "Datadog logging block end was not found");

const requests = [];
const storedValues = new Map();
const listeners = new Map();
const documentListeners = new Map();
const timers = [];
let originalConsoleErrorCalls = 0;
let nextFetchResponse;
let nextFetchError;

class FakeXMLHttpRequest {
  constructor() {
    this.listeners = {};
    this.status = 0;
    this.responseText = "";
  }

  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }

  open() {}

  send() {
    this.sent = true;
  }

  emit(type) {
    this.listeners[type].call(this);
  }
}

function runTimers() {
  while (timers.length) {
    timers.shift()();
  }
}

function addListener(type, callback) {
  const callbacks = listeners.get(type) || [];
  callbacks.push(callback);
  listeners.set(type, callbacks);
}

const context = {
  isStagingEnv: true,
  location: {
    origin: "https://securestaging.gethealthie.com",
    pathname: "/users/123/private_notes/edit/456",
  },
  GM_getValue: (key, fallback) => storedValues.get(key) || fallback,
  GM_setValue: (key, value) => storedValues.set(key, value),
  GM_xmlhttpRequest: (request) => requests.push(request),
  window: {
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    addEventListener: addListener,
  },
  unsafeWindow: {
    addEventListener: addListener,
    fetch() {
      if (nextFetchError) {
        return Promise.reject(nextFetchError);
      }
      return Promise.resolve(nextFetchResponse);
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    console: {
      error() {
        originalConsoleErrorCalls += 1;
      },
    },
  },
  document: {
    addEventListener: (type, callback) => documentListeners.set(type, callback),
  },
  URL,
  crypto: globalThis.crypto,
};

vm.createContext(context);
vm.runInContext(
  `${source.slice(start, end)}
this.datadogApi = {
  sanitizeForDatadog,
  safeUrl,
  errorFingerprint,
  errorSummary,
  graphqlErrorSummary,
  chartNoteAction,
  enqueueDatadogLog,
  setupHealthieDatadogLogs,
  getDatadogState: () => ({ ...ddSentBySeverity })
};`,
  context
);

const {
  sanitizeForDatadog,
  safeUrl,
  errorFingerprint,
  errorSummary,
  graphqlErrorSummary,
  chartNoteAction,
  enqueueDatadogLog,
  setupHealthieDatadogLogs,
  getDatadogState,
} = context.datadogApi;

test("careplan Datadog logging", async function () {
  assert.equal(
    sanitizeForDatadog("user@example.com https://example.com/path?token=secret#fragment"),
    "[email] https://example.com/path"
  );
  assert.equal(
    safeUrl("https://securestaging.gethealthie.com/users/123/graphql?token=secret"),
    "https://securestaging.gethealthie.com/users/:id/graphql"
  );
  assert.equal(errorFingerprint("patient Jane Doe"), errorFingerprint("patient Jane Doe"));
  assert.notEqual(errorFingerprint("patient Jane Doe"), errorFingerprint("patient John Doe"));
  assert.match(
    errorSummary("console", { name: "TypeError", message: "patient Jane Doe" }),
    /^console_error name=TypeError fingerprint=[0-9a-f]{8}$/
  );
  assert.equal(
    graphqlErrorSummary('{"errors":[{"extensions":{"code":"LOCK_FAILED"}},{"message":"other"}]}'),
    "count=2 code=LOCK_FAILED"
  );
  assert.equal(graphqlErrorSummary('{"data":{"ok":true}}'), "");
  assert.equal(chartNoteAction("sign and lock note"), "sign and lock");
  assert.equal(chartNoteAction("sign & lock"), "sign and lock");
  assert.equal(chartNoteAction("lock"), "lock");
  assert.equal(chartNoteAction("sign"), "sign");
  assert.equal(chartNoteAction("save"), "");

  enqueueDatadogLog("info", "diagnostic", "VX-3525 test user@example.com");
  enqueueDatadogLog("info", "diagnostic", "VX-3525 test user@example.com");
  assert.equal(timers.length, 1, "duplicate logs should schedule one flush");
  runTimers();
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].data);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].service, "tampermonkey-healthie");
  assert.equal(payload[0].tm_kind, "diagnostic");
  assert.equal(payload[0].healthie_path, "/users/:id/private_notes/edit/:id");
  assert.ok(payload[0].tm_install_id);
  assert.ok(payload[0].page_id);
  assert.equal(payload[0].message, "[diagnostic] VX-3525 test [email]");
  assert.match(requests[0].url, /dd-api-key=pub/);
  assert.equal(requests[0].headers["DD-API-KEY"], undefined);

  enqueueDatadogLog("info", "diagnostic", "different message");
  runTimers();
  assert.equal(requests.length, 2, "a different message should be sent");

  setupHealthieDatadogLogs();
  runTimers();
  assert.equal(JSON.parse(requests.at(-1).data)[0].tm_kind, "lifecycle");
  assert.ok(listeners.has("error"));
  assert.ok(listeners.has("unhandledrejection"));
  assert.ok(documentListeners.has("click"));

  const diagnosticPromise = context.unsafeWindow.__voriDatadogTest();
  const diagnosticRequest = requests.at(-1);
  const diagnosticPayload = JSON.parse(diagnosticRequest.data);
  assert.ok(diagnosticPayload[0].test_id);
  diagnosticRequest.onload({ status: 202 });
  const diagnostic = await diagnosticPromise;
  assert.equal(diagnostic.accepted, true);
  assert.equal(diagnostic.status, 202);
  assert.ok(diagnostic.test_id);
  assert.equal(diagnosticPayload[0].test_id, diagnostic.test_id);
  assert.equal(context.unsafeWindow.__voriDatadogLastStatus, diagnostic);

  nextFetchResponse = {
    status: 500,
    ok: false,
  };
  const response = await context.unsafeWindow.fetch(
    new URL("https://securestaging.gethealthie.com/users/123/graphql?secret=value")
  );
  assert.equal(response, nextFetchResponse, "fetch response should pass through unchanged");
  runTimers();
  const fetchPayload = JSON.parse(requests.at(-1).data).find((entry) => entry.tm_kind === "http");
  assert.equal(fetchPayload.status, "error");
  assert.equal(fetchPayload.tm_severity, "error");
  assert.equal(fetchPayload.http_status, 500);
  assert.equal(
    fetchPayload.message,
    "[http] GET 500 https://securestaging.gethealthie.com/users/:id/graphql"
  );

  const networkError = new Error("patient Jane Doe could not load");
  nextFetchError = networkError;
  await assert.rejects(
    context.unsafeWindow.fetch("https://securestaging.gethealthie.com/graphql"),
    (error) => error === networkError
  );
  nextFetchError = undefined;
  runTimers();
  assert.doesNotMatch(requests.at(-1).data, /Jane Doe/);

  const xhr = new context.unsafeWindow.XMLHttpRequest();
  xhr.open("POST", "https://securestaging.gethealthie.com/users/123/graphql?secret=value");
  xhr.send();
  xhr.status = 400;
  xhr.emit("loadend");
  runTimers();
  const xhrPayload = JSON.parse(requests.at(-1).data).at(-1);
  assert.equal(xhrPayload.status, "warn");
  assert.equal(xhrPayload.tm_severity, "warn");
  assert.equal(xhrPayload.http_status, 400);
  assert.match(xhrPayload.message, /POST 400 https:\/\/securestaging\.gethealthie\.com\/users\/:id\/graphql/);

  context.unsafeWindow.console.error("patient Jane Doe", new Error("date of birth"));
  assert.equal(originalConsoleErrorCalls, 1, "original console.error should still run");
  runTimers();
  assert.doesNotMatch(requests.at(-1).data, /Jane Doe|date of birth/);

  nextFetchResponse = {
    status: 200,
    ok: true,
    clone: () => ({
      text: async () => '{"errors":[{"extensions":{"code":"LOCK_FAILED"}}]}',
    }),
  };
  await context.unsafeWindow.fetch("https://securestaging.gethealthie.com/graphql");
  await new Promise((resolve) => setImmediate(resolve));
  runTimers();
  const graphqlPayload = JSON.parse(requests.at(-1).data).at(-1);
  assert.equal(graphqlPayload.status, "warn");
  assert.equal(graphqlPayload.tm_kind, "graphql");
  assert.match(graphqlPayload.message, /\[graphql\] count=1 code=LOCK_FAILED/);

  listeners.get("error")[0]({
    target: context.unsafeWindow,
    message: "patient Jane Doe",
    filename: "https://securestaging.gethealthie.com/users/123/app.js?token=secret",
    lineno: 42,
    error: { name: "TypeError", message: "patient Jane Doe" },
  });
  listeners.get("unhandledrejection")[0]({
    reason: { name: "Error", message: "date of birth missing" },
  });
  runTimers();
  const errorPayload = requests.slice(-1).flatMap((request) => JSON.parse(request.data));
  assert.doesNotMatch(JSON.stringify(errorPayload), /Jane Doe|date of birth|token=secret/);
  assert.match(JSON.stringify(errorPayload), /users\/:id\/app\.js:42/);
  assert.match(JSON.stringify(errorPayload), /unhandledrejection_error name=Error fingerprint=/);

  documentListeners.get("click")({
    target: {
      closest: () => ({ innerText: "Sign & Lock" }),
    },
  });
  runTimers();
  const clickPayload = JSON.parse(requests.at(-1).data).at(-1);
  assert.equal(clickPayload.status, "info");
  assert.equal(clickPayload.tm_kind, "chart-note");
  assert.match(clickPayload.message, /\[chart-note\] clicked sign and lock/);

  const sentBeforeRateLimitTest = getDatadogState().info;
  for (let i = 0; i < 31; i++) {
    enqueueDatadogLog("info", "rate-test", "message-" + i);
  }
  runTimers();
  assert.equal(getDatadogState().info, 30);
  const rateLogsSent = requests
    .flatMap((request) => JSON.parse(request.data))
    .filter((log) => log.tm_kind === "rate-test");
  assert.equal(rateLogsSent.length, 30 - sentBeforeRateLimitTest);

});
