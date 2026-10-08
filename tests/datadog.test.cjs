const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto } = require("node:crypto");
const vm = require("node:vm");
const { test } = require("node:test");

const source = readFileSync(process.env.USERSCRIPT_PATH || "careplan.js", "utf8");
function harness(overrides = {}) {
  const sent = [],
    timers = new Map(),
    storage = new Map(),
    listeners = {};
  let timerId = 0;
  class XHR extends EventTarget {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send() {
      this.sent = true;
    }
  }
  const page = {
    jQuery() {},
    fetch: async () => ({ status: 200, ok: true }),
    XMLHttpRequest: XHR,
    console: { log() {}, error() {} },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    ...overrides.page,
  };
  const context = vm.createContext({
    URL,
    crypto: webcrypto,
    console: page.console,
    location: {
      href: "https://vorihealth.gethealthie.com/users/123/private_notes/edit/456",
      origin: "https://vorihealth.gethealthie.com",
      pathname: "/users/123/private_notes/edit/456",
    },
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    GM_xmlhttpRequest: (options) => {
      sent.push(options);
      options.onload({ status: 202 });
    },
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener: page.addEventListener,
    fetch: page.fetch,
    document: {
      addEventListener(type, fn) {
        (listeners["document:" + type] ||= []).push(fn);
      },
    },
    MutationObserver: class {
      observe() {}
    },
    unsafeWindow: page,
    ...overrides.globals,
  });
  context.window = context;
  const run = (code) => vm.runInContext(code, context);
  run(source);
  const logs = () => {
    run("flushDatadogLogsNow()");
    return sent.flatMap((r) => JSON.parse(r.data));
  };
  return { run, context, page, sent, timers, storage, listeners, logs };
}

test("URL telemetry removes names, email addresses, query values and all dynamic route segments", () => {
  const h = harness();
  h.run(
    `noteHttpResult('POST', 'https://api.gethealthie.com/users/JaneDoe/files/medical-report.pdf?token=secret', 500)`
  );
  h.context.location.pathname = "/users/jane%40example.com/private_notes/edit/note-abc";
  h.run(`enqueueDatadogLog('info', 'navigation', normalizePath(location.pathname))`);
  const output = JSON.stringify(h.logs());
  for (const value of ["JaneDoe", "medical-report", "secret", "jane", "note-abc"])
    assert.ok(!output.includes(value), value);
  assert.match(output, /private_notes\/edit/);
});

test("custom error names and GraphQL error codes cannot carry patient data", () => {
  const h = harness();
  h.run(
    `enqueueDatadogLog('error', 'window', errorSummary('window', {name:'JaneDoe',message:'Jane Doe diagnosis'})); noteGraphqlText('/graphql', JSON.stringify({errors:[{extensions:{code:'JaneDoe'}}]}))`
  );
  assert.ok(!JSON.stringify(h.logs()).includes("Jane"));
});

test("telemetry storage and random ID failures do not prevent userscript initialization", () => {
  const h = harness({
    globals: {
      crypto: {
        getRandomValues() {
          throw new Error("unavailable");
        },
      },
      GM_getValue(key, fallback) {
        if (key.startsWith("voriDatadog")) throw new Error("storage unavailable");
        return fallback;
      },
      GM_setValue() {
        throw new Error("storage unavailable");
      },
    },
  });
  assert.equal(h.run("typeof observer"), "object");
});

test("transport failures cannot escape flush or prevent subsequent batches", () => {
  const h = harness({
    globals: {
      GM_xmlhttpRequest() {
        throw new Error("extension unavailable");
      },
    },
  });
  h.run(`enqueueDatadogLog('error', 'window', 'test'); flushDatadogLogsNow()`);
  assert.ok(h.listeners.error.length);
});

test("diagnostic resolves on timeout and abort, and never marks a failed probe as sent", async () => {
  for (const callback of ["ontimeout", "onabort", "onerror"]) {
    const h = harness({
      globals: {
        GM_xmlhttpRequest(options) {
          assert.ok(options.timeout > 0);
          options[callback]();
        },
      },
    });
    const result = await h.page.__voriDatadogTest();
    assert.equal(result.accepted, false);
    assert.equal(h.storage.has("voriDatadogProbeAt"), false);
  }
});

test("fetch still reaches the native implementation when telemetry metadata throws", async () => {
  let called = 0;
  const response = { status: 200 };
  const h = harness({
    page: {
      fetch: async () => {
        called++;
        return response;
      },
    },
  });
  const init = {
    get method() {
      throw new Error("telemetry metadata");
    },
  };
  assert.equal(await h.page.fetch("/graphql", init), response);
  assert.equal(called, 1);
});

test("fetch preserves receiver, arguments, responses, and original rejection", async () => {
  const failure = new TypeError("private error message");
  const response = { status: 500, ok: false };
  const calls = [];
  const h = harness({
    page: {
      fetch(...args) {
        calls.push([this, ...args]);
        return args[0] === "/fail" ? Promise.reject(failure) : Promise.resolve(response);
      },
    },
  });
  const init = { method: "POST", body: "sensitive note content" };
  assert.equal(await h.page.fetch("/graphql", init), response);
  await assert.rejects(h.page.fetch("/fail"), (e) => e === failure);
  assert.equal(calls[0][0], h.page);
  assert.equal(calls[0][2], init);
  assert.ok(!JSON.stringify(h.logs()).includes("sensitive"));
});

test("userscript fetch failures are captured separately from page fetch", async () => {
  const failure = new Error("sandbox fetch failed");
  const h = harness({
    globals: {
      fetch: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(h.run(`healthieGQL('{"query":"test"}')`), (e) => e === failure);
  assert.ok(h.logs().some((log) => log.tm_kind === "http" && log.status === "error"));
});

test("GraphQL mutation validation messages are counted without recording payloads", () => {
  const h = harness();
  h.run(
    `noteGraphqlText('/graphql', JSON.stringify({data:{signNote:{messages:[{message:'Jane Doe clinical note',field:'name'}]}}}))`
  );
  const logs = h.logs().filter((log) => log.tm_kind === "graphql");
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /count=1/);
  assert.ok(!JSON.stringify(logs).includes("Jane"));
});

test("one unavailable page hook does not prevent error listeners and startup logging", () => {
  const h = harness();
  h.run("ddHooksInstalled = false");
  Object.defineProperty(h.page, "fetch", {
    get() {
      throw new Error("blocked");
    },
  });
  const before = h.listeners.error.length;
  h.run("setupHealthieDatadogLogs()");
  assert.ok(h.listeners.error.length > before);
});

test("charting clicks include Healthie Lock Note and Sign Note confirmation labels", () => {
  const h = harness();
  for (const label of ["Sign and lock", "Lock Note", "Sign Note"]) {
    h.listeners["document:click"][0]({ target: { closest: () => ({ innerText: label }) } });
  }
  assert.equal(h.logs().filter((log) => log.tm_kind === "chart-note").length, 3);
});

test("rate limits separate severities and consecutive duplicates", () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.run(`enqueueDatadogLog('info', 'test', 'event ${i}')`);
  h.run(`enqueueDatadogLog('error', 'test', 'failure'); enqueueDatadogLog('error', 'test', 'failure')`);
  for (let i = 0; i < 5; i++) h.run("flushDatadogLogsNow()");
  const logs = h.sent.flatMap((r) => JSON.parse(r.data));
  assert.equal(logs.filter((log) => log.tm_kind === "test" && log.status === "error").length, 1);
  assert.ok(logs.filter((log) => log.status === "info" && log.tm_kind !== "probe").length <= 30);
});

test("XHR reuse retains one observer and preserves native send when listener setup fails", () => {
  const h = harness();
  let observations = 0;
  h.context.countXhr = () => observations++;
  h.run("noteXhrResult = countXhr");
  const xhr = new h.page.XMLHttpRequest();
  for (let i = 0; i < 3; i++) {
    xhr.open("POST", "/graphql");
    xhr.send();
    xhr.dispatchEvent(new Event("loadend"));
  }
  assert.equal(observations, 3);
  xhr.addEventListener = () => {
    throw new Error("observer unavailable");
  };
  xhr.sent = false;
  xhr.send();
  assert.equal(xhr.sent, true);
});

test("XHR network and timeout failures are reported without treating aborts as failures", () => {
  const h = harness();
  const xhr = new h.page.XMLHttpRequest();
  xhr.open("POST", "/graphql");
  xhr.send();
  xhr.dispatchEvent(new Event("abort"));
  assert.equal(h.logs().filter((log) => log.tm_kind === "http").length, 0);
  xhr.dispatchEvent(new Event("error"));
  assert.equal(h.logs().filter((log) => log.tm_kind === "http").length, 1);
});

test("pagehide flushes all queued batches without leaving timers behind", () => {
  const h = harness();
  for (let i = 0; i < 24; i++) h.run(`enqueueDatadogLog('info', 'test', 'event ${i}')`);
  h.listeners.pagehide[0]();
  assert.equal(h.sent.flatMap((r) => JSON.parse(r.data)).filter((log) => log.tm_kind === "test").length, 24);
  assert.equal(h.timers.size, 0);
});

test("fetch cloning preserves the original GraphQL response and ignores aborted requests", async () => {
  const body = { data: { signNote: { messages: [{ field: "note", message: "private note" }] } } };
  const response = new Response(JSON.stringify(body));
  const h = harness({ page: { fetch: async () => response } });
  const actual = await h.page.fetch("/graphql");
  assert.equal(actual, response);
  assert.deepEqual(await actual.json(), body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.logs().some((log) => log.tm_kind === "graphql"));
  h.run(`noteFetchFailure('POST', '/graphql', {name:'AbortError',message:'cancel'})`);
  assert.ok(!h.logs().some((log) => log.tm_kind === "http"));
});

test("care-plan request order stays unchanged while deletes are pending", async () => {
  const calls = [];
  const h = harness();
  h.context.recordGql = (payload) => {
    const { query } = JSON.parse(payload);
    calls.push(query);
    if (query.includes("goals(user_id")) return Promise.resolve({ data: { goals: [{ id: "987" }] } });
    return new Promise(() => {});
  };
  h.run(
    `healthieGQL = recordGql; patientNumber = '123'; handleCarePlanTmInput({goal:{title:'goal'},milestones:[{title:'milestone',isVisible:true}],tasks:{tasks:[{title:'task',isVisible:true}]}})`
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 5);
  assert.match(calls[1], /deleteGoal/);
  assert.match(calls[2], /name: "milestone"/);
  assert.match(calls[3], /name: "goal"/);
  assert.match(calls[4], /name: "task"/);
});

test("ordinary conversation messages are not GraphQL validation errors", () => {
  const h = harness();
  h.run(
    `noteGraphqlText('/graphql', JSON.stringify({data:{conversation:{messages:[{message:'normal chat',id:'1'}]}}}))`
  );
  assert.equal(h.logs().filter((log) => log.tm_kind === "graphql").length, 0);
});

test("userscript update version and emitted telemetry version stay aligned", () => {
  const version = source.match(/^\/\/ @version\s+(\S+)/m)?.[1];
  assert.ok(version, "userscript update header must be present");
  const h = harness();
  assert.equal(h.run("TM_VERSION"), version);
  const logs = h.logs();
  assert.ok(logs.length > 0, "initialization emits telemetry");
  for (const log of logs) assert.equal(log.tm_version, version);
});
