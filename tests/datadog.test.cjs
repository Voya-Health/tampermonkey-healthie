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
    browserStorage = new Map(Object.entries(overrides.browserStorage || {})),
    tabStorage = new Map(Object.entries(overrides.tabStorage || {})),
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
    localStorage: { getItem: (key) => browserStorage.get(key) ?? null },
    sessionStorage: { getItem: (key) => tabStorage.get(key) ?? null },
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
    AbortController,
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
  return { run, context, page, sent, timers, storage, browserStorage, tabStorage, listeners, logs };
}

test("browser session identifies the viewer on all routes without a userscript API key or iframe", async () => {
  for (const path of ["/", "/clients/active", "/appointments", "/settings/account", "/users/123/Overview", "/users/123/private_notes/edit/456"]) {
    const requests = [];
    const h = harness({
      browserStorage: {"blog:token": "viewer-session", "blog:source": "Web"},
      globals: { location: {origin:"https://vorihealth.gethealthie.com", pathname:path, href:"https://vorihealth.gethealthie.com" + path} },
      page: {fetch: async (url, init) => {
        requests.push({url, init});
        return new Response(JSON.stringify({data: {currentUser: {id:"42", email:"ada@vorihealth.com", full_name:"Ada Lovelace", is_patient:false}}}));
      }},
    });
    h.run(`enqueueDatadogLog('error','window','route failure')`);
    h.run("flushDatadogLogs()");
    assert.equal(h.sent.length, 0, "normal batches wait for the session identity");
    await h.run("loadViewingClinician()");
    const log = h.logs().find((entry) => entry.tm_kind === "window");
    assert.equal(log.clinician_id, "42", path);
    assert.equal(log.clinician_identity_source, "healthie_browser_session");
    assert.equal(log.healthie_path, path);
    assert.match(log.message, /Ada Lovelace <ada@vorihealth.com>/);
    assert.equal(requests.length, 1, "one lookup per session");
    assert.equal(requests[0].init.headers.Authorization, "Bearer viewer-session");
    assert.equal(requests[0].init.headers.AuthorizationSource, "Web");
    assert.match(JSON.parse(requests[0].init.body).query, /currentUser/);
    const probe = h.logs().find((entry) => entry.tm_kind === "probe");
    assert.equal(probe.clinician_id, "42", "daily probe waits for identity");
    assert.ok(!JSON.stringify(h.logs()).includes("viewer-session"), "session token stays out of logs");
  }
});

test("shared API key owner cannot replace the authenticated browser clinician", async () => {
  const h = harness({
    tabStorage: {"blog:token":"session-clinician"},
    globals: {GM_getValue: (key, fallback) => key === "healthieApiKey" ? "shared-api-key" : fallback},
    page: {fetch: async (_, init) => new Response(JSON.stringify({data: {
      currentUser: init.headers.Authorization === "Bearer session-clinician" ? {id:"42",full_name:"Actual Viewer"} : {id:"999",full_name:"API Key Owner"},
      user: {id:"999",full_name:"API Key Owner"},
    }}))},
  });
  await h.run("loadViewingClinician()");
  await new Promise((resolve) => setImmediate(resolve));
  const log = h.run(`makeDatadogLog('info','navigation','viewer')`);
  assert.equal(log.clinician_id, "42");
  assert.match(log.message, /Actual Viewer/);
  assert.ok(!JSON.stringify(h.logs()).includes("API Key Owner"));
});

test("session switches clear the old clinician and ignore late responses from the previous session", async () => {
  const resolveByToken = new Map();
  const h = harness({
    browserStorage: {"blog:token":"session-a"},
    page: {fetch: (_, init) => new Promise((resolve) => resolveByToken.set(init.headers.Authorization, resolve))},
  });
  h.run(`enqueueDatadogLog('info','test','session-a action')`);
  await new Promise((resolve) => setImmediate(resolve));
  h.browserStorage.set("blog:token", "session-b");
  h.run(`enqueueDatadogLog('info','test','session-b action')`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.run("ddClinician"), null);
  resolveByToken.get("Bearer session-b")(new Response(JSON.stringify({data:{currentUser:{id:"43",full_name:"Grace"}}})));
  await h.run("loadViewingClinician()");
  resolveByToken.get("Bearer session-a")(new Response(JSON.stringify({data:{currentUser:{id:"42",full_name:"Ada"}}})));
  await new Promise((resolve) => setImmediate(resolve));
  const logs = h.logs();
  assert.equal(logs.find((log) => log.tm_detail === "session-a action").clinician_id, undefined);
  assert.equal(logs.find((log) => log.tm_detail === "session-b action").clinician_id, "43");
  h.browserStorage.delete("blog:token");
  const logout = h.run(`makeDatadogLog('info','test','signed out')`);
  assert.equal(logout.clinician_id, undefined);
  assert.equal(logout.clinician_identity_status, "unavailable");
});

test("session lookup rejects patient identities and retries failures only after its cooldown", async () => {
  let now = 100000;
  class TestDate extends Date { static now() { return now; } }
  let calls = 0;
  const h = harness({
    browserStorage: {"blog:token":"session"},
    globals: {Date: TestDate},
    page: {fetch: async () => { calls++; return new Response(JSON.stringify({data:{currentUser:{id:"123",full_name:"Patient",is_patient:true}}})); }},
  });
  await h.run("loadViewingClinician()");
  assert.equal(h.run("ddClinician"), null);
  for (let i=0;i<50;i++) h.run(`makeDatadogLog('info','test','failed lookup')`);
  assert.equal(calls, 1);
  now += 30000;
  h.page.fetch = async () => {calls++; return new Response(JSON.stringify({data:{currentUser:{id:"42",full_name:"Clinician"}}}));};
  await h.run("loadViewingClinician()");
  assert.equal(calls, 2);
  assert.equal(h.run("ddClinician.id"), "42");
});

test("lookup timeout is bounded even when the fetch promise ignores abort", async () => {
  const h = harness({browserStorage:{"blog:token":"session"},page:{fetch:()=>new Promise(()=>{})}});
  h.run(`enqueueDatadogLog('error','window','lookup timed out')`);
  const timeout = Array.from(h.timers.values()).find((timer) => timer.delay === 10000);
  assert.ok(timeout, "identity lookup needs a deadline");
  timeout.fn();
  await h.run("ddViewerLookup");
  const log = h.logs().find((entry) => entry.tm_kind === "window");
  assert.equal(log.clinician_identity_status, "unavailable");
  assert.equal(log.clinician_id, undefined);
});

test("expired, partial, and malformed session responses never use the API key owner", async () => {
  for (const response of [
    new Response('{}', {status:401}),
    new Response(JSON.stringify({data:{user:{id:"999",full_name:"API key owner"}}})),
    new Response(JSON.stringify({errors:[{message:"session expired"}]})),
    new Response('not json'),
  ]) {
    const h = harness({browserStorage:{"blog:token":"expired"},page:{fetch:async()=>response}});
    await h.run("loadViewingClinician()");
    const log = h.run(`makeDatadogLog('error','test','expired session')`);
    assert.equal(log.clinician_identity_status, "unavailable");
    assert.equal(log.clinician_id, undefined);
  }
});

test("blocked persistent storage falls back to the active tab session", async () => {
  const h = harness({tabStorage:{"blog:token":"tab-session"},page:{
    localStorage:{getItem(){throw new Error("storage blocked");}},
    fetch:async()=>new Response(JSON.stringify({data:{currentUser:{id:"42",full_name:"Ada"}}})),
  }});
  await h.run("loadViewingClinician()");
  assert.equal(h.run("ddClinician.id"), "42");
});

test("URL telemetry keeps the full path and drops query tokens", () => {
  const h = harness();
  h.run(
    `noteHttpResult('POST', 'https://api.gethealthie.com/users/JaneDoe/files/medical-report.pdf?token=secret', 500)`
  );
  h.context.location.pathname = "/users/jane%40example.com/private_notes/edit/note-abc";
  h.run(`enqueueDatadogLog('info', 'navigation', pagePath())`);
  const output = JSON.stringify(h.logs());
  assert.ok(!output.includes("secret"), "query token");
  for (const value of ["JaneDoe", "medical-report", "jane@example.com", "note-abc", "private_notes/edit"])
    assert.ok(output.includes(value), value);
});

test("error text and GraphQL messages are sent in full", () => {
  const h = harness();
  h.run(
    `enqueueDatadogLog('error', 'window', datadogErrorDetail('window', {name:'TypeError',message:'Jane Doe diagnosis'})); noteGraphqlText('/graphql', JSON.stringify({errors:[{message:'Jane Doe diagnosis'}]}))`
  );
  const output = JSON.stringify(h.logs());
  assert.ok(output.includes("Jane Doe diagnosis"));
  assert.ok(output.includes("TypeError"));
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
  const before = called;
  assert.equal(await h.page.fetch("/graphql", init), response);
  assert.equal(called, before + 1);
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
  const tracked = calls.find((call) => call[2] === init);
  assert.equal(tracked[0], h.page);
  assert.equal(tracked[2], init);
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

test("GraphQL mutation validation messages include the message text", () => {
  const h = harness();
  h.run(
    `noteGraphqlText('/graphql', JSON.stringify({data:{signNote:{messages:[{message:'Jane Doe clinical note',field:'name'}]}}}))`
  );
  const logs = h.logs().filter((log) => log.tm_kind === "graphql");
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /count=1/);
  assert.ok(logs[0].message.includes("Jane Doe clinical note"));
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
  const failures = logs.filter((log) => log.tm_kind === "test" && log.status === "error");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].repeat_count, 2);
  assert.ok(logs.filter((log) => log.status === "info" && log.tm_kind !== "probe").length <= 30);
});

test("repeated fingerprints collapse for the page and external 401s are dropped", () => {
  const h = harness();
  h.run(`noteHttpResult('POST', 'https://cdn.example.com/assets/app.js', 401)`);
  h.run(`noteHttpResult('PUT', 'https://cdn.example.com/other.js', 401)`);
  h.run(`noteHttpResult('POST', 'https://staging-api.gethealthie.com/graphql', 401)`);
  h.run(`noteHttpResult('POST', 'https://cdn.example.com/assets/app.js', 500)`);
  for (let i = 0; i < 4; i++) {
    h.run(`enqueueDatadogLog('error', 'window', 'window_error name=Error fingerprint=168cc1eb')`);
    h.run(`enqueueDatadogLog('error', 'http', 'POST network_error https://staging-api.gethealthie.com/graphql fingerprint=46df08c9')`);
  }
  const logs = h.logs();
  assert.equal(logs.filter((log) => log.http_status === 401 && String(log.message).includes("[external]")).length, 0);
  assert.equal(logs.filter((log) => log.http_status === 401).length, 1);
  assert.equal(logs.filter((log) => log.http_status === 500).length, 1);
  const windowLogs = logs.filter((log) => log.message.includes("168cc1eb"));
  const httpLogs = logs.filter((log) => log.message.includes("46df08c9"));
  assert.equal(windowLogs.length, 1);
  assert.equal(windowLogs[0].repeat_count, 4);
  assert.equal(httpLogs.length, 1);
  assert.equal(httpLogs[0].repeat_count, 4);
  h.run(`enqueueDatadogLog('error', 'window', 'window_error name=Error fingerprint=168cc1eb')`);
  const again = h.logs().filter((log) => log.message.includes("168cc1eb"));
  assert.equal(again.length, 1);
  assert.equal(again[0].repeat_count, 4);
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
  let response;
  const h = harness({
    page: {
      fetch: async () => {
        response = new Response(JSON.stringify(body));
        return response;
      },
    },
  });
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

test("viewing clinician id, email, and name are attached with the script version", async () => {
  const h = harness({browserStorage:{"blog:token":"session"}, page:{fetch:async () => new Response(JSON.stringify({data:{currentUser:{id:42,email:"ada@vorihealth.com",full_name:"Ada Lovelace",first_name:"Wrong"}}}))}});
  await h.run("loadViewingClinician()");
  h.run(`enqueueDatadogLog('info', 'test', 'viewer check')`);
  const log = h.logs().find((entry) => entry.message.includes("viewer check"));
  assert.equal(log.clinician_id, "42");
  assert.equal(log.clinician_email, "ada@vorihealth.com");
  assert.equal(log.clinician_name, "Ada Lovelace");
  assert.equal(log.tm_version, h.run("TM_VERSION"));
  assert.equal(log.healthie_path, "/users/123/private_notes/edit/456");
});

test("content shows clinician, version, severity, action, original path, and repeat count", () => {
  const h = harness();
  h.run(`enqueueDatadogLog('error', 'window', 'TypeError: Cannot read id'); enqueueDatadogLog('error', 'window', 'TypeError: Cannot read id')`);
  h.context.location.pathname = "/users/999/Overview";
  h.run(`rememberClinician({id:42,email:'ada@vorihealth.com',full_name:'Ada Lovelace'})`);
  const log = h.logs().find((entry) => entry.tm_kind === "window");
  assert.equal(log.message, "[ERROR] [TM v2.6] Ada Lovelace <ada@vorihealth.com> (Healthie ID: 42) | [window] TypeError: Cannot read id | path=/users/123/private_notes/edit/456 | repeats=2");
  assert.equal(log.clinician_identity_source, "healthie_browser_session");
  assert.equal(log.tm_detail, "TypeError: Cannot read id");
  assert.ok(log.last_seen_at >= log.timestamp);
});

test("each sign and lock click is retained, including after navigation", () => {
  const h = harness();
  h.run(`rememberClinician({id:42,first_name:'Ada',last_name:'Lovelace'})`);
  const click = () => h.listeners["document:click"][0]({ target: { closest: () => ({ innerText: "Sign and lock" }) } });
  click();
  click();
  h.logs();
  click();
  h.context.location.pathname = "/users/999/private_notes/edit/789";
  click();
  const logs = h.logs().filter((entry) => entry.tm_kind === "chart-note");
  assert.equal(logs.length, 4);
  assert.equal(logs[0].message, "[INFO] [TM v2.6] Ada Lovelace (Healthie ID: 42) | [chart-note] clicked sign and lock | path=/users/123/private_notes/edit/456");
  assert.equal(logs[3].healthie_path, "/users/999/private_notes/edit/789");
  for (const log of logs) assert.equal(log.repeat_count, 1);
});

test("failure collapse separates page paths and clinicians and keeps the event identity", () => {
  const h = harness();
  h.run(`rememberClinician({id:42,full_name:'Ada'}); enqueueDatadogLog('error','window','same failure')`);
  h.context.location.pathname = "/users/999/Overview";
  h.run(`enqueueDatadogLog('error','window','same failure'); rememberClinician({id:43,full_name:'Grace'}); enqueueDatadogLog('error','window','same failure')`);
  const logs = h.logs().filter((entry) => entry.tm_kind === "window");
  assert.equal(logs.length, 3);
  assert.equal(logs[0].clinician_name, "Ada");
  assert.equal(logs[1].clinician_name, "Ada");
  assert.equal(logs[2].clinician_name, "Grace");
  assert.match(logs[0].message, /Ada .*path=\/users\/123\//);
});

test("lookup failure is visible and never invents a clinician from a patient route", async () => {
  const h = harness({browserStorage:{"blog:token":"session"}, page:{fetch:async () => {throw new Error("lookup failed");}}});
  const pending = h.run(`makeDatadogLog('info','test','before lookup')`);
  assert.match(pending.message, /Clinician pending/);
  await h.run("loadViewingClinician()");
  const log = h.logs().find((entry) => entry.tm_kind === "lifecycle");
  assert.match(log.message, /Clinician unavailable/);
  assert.equal(log.clinician_identity_status, "unavailable");
  assert.equal(log.clinician_id, undefined);
  h.run(`rememberClinician({id:7,email:'only@example.com'})`);
  assert.match(h.run(`makeDatadogLog('warn','test','email only').message`), /only@example.com.*Healthie ID: 7/);
});

test("repeat windows use the original timestamp and show the final count in content", () => {
  let now = 100000;
  class TestDate extends Date { static now() { return now; } }
  const h = harness({ globals: { Date: TestDate } });
  h.run(`enqueueDatadogLog('error','window','continuous')`);
  for (let second = 1; second <= 30; second++) {
    now = 100000 + second * 1000;
    h.run(`enqueueDatadogLog('error','window','continuous'); flushDatadogLogs()`);
  }
  const log = h.sent.flatMap((r) => JSON.parse(r.data)).find((entry) => entry.tm_kind === "window");
  assert.ok(log, "continuous repeats must send at 30 seconds");
  assert.equal(log.repeat_count, 31);
  assert.equal(log.timestamp, 100000);
  assert.equal(log.last_seen_at, 130000);
  assert.match(log.message, /repeats=31$/);
  h.run(`enqueueDatadogLog('error','window','continuous')`);
  assert.equal(h.logs().filter((entry) => entry.tm_kind === "window").length, 1);

  h.run(`enqueueDatadogLog('error','console','quiet')`);
  now += 1999;
  h.run(`flushDatadogLogs()`);
  assert.equal(h.sent.flatMap((r) => JSON.parse(r.data)).filter((entry) => entry.tm_kind === "console").length, 0);
  now += 1;
  h.run(`flushDatadogLogs()`);
  assert.equal(h.sent.flatMap((r) => JSON.parse(r.data)).filter((entry) => entry.tm_kind === "console").length, 1);
});

test("malformed and unresolved clinician lookups keep logs usable without false attribution", async () => {
  const h = harness();
  for (const user of [null, {}, [], {id: " "}, {id: {}}, {id: NaN}]) {
    h.context.lookupUser = user;
    h.run(`rememberClinician(lookupUser)`);
    const log = h.run(`makeDatadogLog('error','test','lookup unavailable')`);
    assert.match(log.message, /Clinician unavailable/);
    assert.equal(log.clinician_id, undefined);
  }
  const pending = harness({browserStorage:{"blog:token":"session"}, page:{fetch:() => new Promise(() => {})}});
  pending.run(`enqueueDatadogLog('error','window','lookup still pending')`);
  const log = pending.logs().find((entry) => entry.tm_kind === "window");
  assert.match(log.message, /Clinician pending/);
  assert.match(log.message, /lookup still pending/);
  const thrown = harness({browserStorage:{"blog:token":"session"}, page:{fetch:() => {throw new Error("private lookup failure");}}});
  const debugMessages = [];
  thrown.page.console.log = (...args) => debugMessages.push(args);
  thrown.run(`debug = true`);
  await thrown.run("loadViewingClinician()");
  assert.match(thrown.run(`makeDatadogLog('error','test','sync failure').message`), /Clinician unavailable/);
  assert.equal(debugMessages.length, 1);
  assert.match(debugMessages[0][0], /clinician-lookup_error name=Error fingerprint=/);
  assert.ok(!JSON.stringify(debugMessages).includes("private lookup failure"));
});

test("oversized detail cannot truncate identity or the path out of content", () => {
  const h = harness();
  h.run(`rememberClinician({id:42,email:'ada@vorihealth.com',full_name:'Ada Lovelace'}); enqueueDatadogLog('error','console','x'.repeat(10000))`);
  const log = h.logs().find((entry) => entry.tm_kind === "console");
  assert.match(log.message, /^\[ERROR\] \[TM v2.6\] Ada Lovelace/);
  assert.match(log.message, /path=\/users\/123\/private_notes\/edit\/456$/);
  assert.equal(log.tm_detail.length, 500);
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

test("diagnostic fallback errors preserve behavior and redact debug output", async () => {
  const debugMessages = [];
  const response = { status: 200, ok: true };
  const h = harness({ page: { fetch: async () => response } });
  h.page.console.log = (...args) => debugMessages.push(args);
  h.run("debug = true");
  h.context.crypto = {
    getRandomValues() { throw new Error("patient Jane Doe"); },
  };
  assert.equal(h.run("randomId(12)"), "unavailable");
  assert.equal(h.run("safeUrl('http://[')"), "invalid-url");
  const input = {
    get method() { throw new Error("private diagnosis for Jane Doe"); },
  };
  assert.equal(await h.page.fetch(input), response);
  assert.equal(debugMessages.length, 3);
  assert.ok(!JSON.stringify(debugMessages).includes("Jane"));
  assert.ok(!JSON.stringify(debugMessages).includes("diagnosis"));
});
