const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const source = readFileSync(process.env.USERSCRIPT_PATH || "careplan.js", "utf8");

// Real browser APIs, synthetic page and extension APIs. No Healthie or Datadog requests leave the test.
async function browserHarness(t, expectedConsoleErrors = [], path = "/users/123/private_notes/edit/456") {
  const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  const unexpectedRequests = [];
  const failedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  t.after(() => assert.deepEqual(errors, [], "unexpected uncaught browser errors"));
  t.after(() => {
    assert.equal(consoleErrors.length, expectedConsoleErrors.length, "unexpected browser console errors: " + consoleErrors.join("\n"));
    for (const [index, pattern] of expectedConsoleErrors.entries()) assert.match(consoleErrors[index], pattern);
    assert.deepEqual(unexpectedRequests, [], "unexpected external requests");
    assert.deepEqual(failedRequests, [], "failed browser requests");
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/graphql" && ["api.gethealthie.com", "vorihealth.gethealthie.com"].includes(url.hostname)) {
      if (request.postData()?.includes("tampermonkeySessionViewer")) {
        assert.equal(request.headers().authorization, "Bearer synthetic-browser-session");
        assert.equal(request.headers().authorizationsource, "Web");
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({data: {currentUser: {id: "42", email: "ada@vorihealth.com", full_name: "Ada Lovelace", is_patient:false}}}),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: { signNote: { messages: [{ field: "note", message: "private clinical text" }] } },
        }),
      });
    }
    if (url.hostname !== "vorihealth.gethealthie.com" || url.pathname !== path) {
      unexpectedRequests.push(request.url());
      return route.abort();
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<button id="sign">Sign and lock</button><button id="lock">Lock Note</button><output id="result"></output>',
    });
  });
  await page.goto("https://vorihealth.gethealthie.com" + path);
  await page.evaluate(() => {
    window.__logs = [];
    window.unsafeWindow = window;
    window.GM_getValue = (_, fallback) => fallback;
    window.GM_setValue = () => {};
    localStorage.setItem("blog:token", "synthetic-browser-session");
    localStorage.setItem("blog:source", "Web");
    window.GM_xmlhttpRequest = (options) => {
      window.__logs.push(...JSON.parse(options.data));
      options.onload({ status: 202 });
    };
    // DOM replacement is outside this test; keep the full userscript's startup intact.
    window.MutationObserver = class {
      observe() {
        /* The fixture does not run Healthie DOM replacement. */
      }
    };
    window.jQuery = () => {};
    document.querySelector("#lock").onclick = () => {
      document.querySelector("#result").textContent = "native click handled";
    };
  });
  await page.addScriptTag({ content: source });
  return page;
}

test("native fetch and reused XHR return their original GraphQL bodies while reporting validation failures", async (t) => {
  const page = await browserHarness(t);
  const result = await page.evaluate(async () => {
    const response = await fetch("/graphql", { method: "POST", body: "synthetic" });
    const fetchBody = await response.json();
    const xhr = new XMLHttpRequest();
    const xhrBodies = [];
    const sendOnce = () =>
      new Promise((resolve, reject) => {
        xhr.open("POST", "/graphql");
        xhr.onload = () => {
          xhrBodies.push(JSON.parse(xhr.responseText));
          resolve();
        };
        xhr.onerror = reject;
        xhr.send("synthetic");
      });
    await sendOnce();
    await sendOnce();
    return { fetchBody, xhrBodies };
  });
  assert.equal(result.fetchBody.data.signNote.messages[0].message, "private clinical text");
  assert.equal(result.xhrBodies.length, 2);
  await page.waitForFunction(() => window.__logs.some((log) => log.tm_kind === "graphql"));
  const logs = await page.evaluate(() => window.__logs);
  assert.ok(JSON.stringify(logs).includes("private clinical text"));
});

test("charting click and error observers retain native handlers and record error text", async (t) => {
  const page = await browserHarness(t, [/^patient Jane Doe Error: sensitive diagnosis/]);
  await page.click("#sign");
  await page.click("#lock");
  assert.equal(await page.locator("#result").textContent(), "native click handled");
  await page.evaluate(() => {
    console.error("patient Jane Doe", new Error("sensitive diagnosis"));
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "private chart text",
        error: new TypeError("private chart text"),
        filename: "https://vorihealth.gethealthie.com/users/JaneDoe.js",
      })
    );
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        reason: new Error("private rejection"),
        promise: Promise.resolve(),
      })
    );
    window.dispatchEvent(new Event("pagehide"));
  });
  const logs = await page.evaluate(() => window.__logs);
  for (const kind of ["chart-note", "console", "window", "unhandledrejection"])
    assert.ok(
      logs.some((log) => log.tm_kind === kind),
      kind
    );
  assert.equal(logs.filter((log) => log.tm_kind === "chart-note").length, 2);
  const output = JSON.stringify(logs);
  assert.match(output, /Jane Doe/);
  assert.match(output, /sensitive diagnosis/);
  assert.match(output, /private chart text/);
  assert.match(output, /private rejection/);
  assert.match(output, /\/users\/123\/private_notes\/edit\/456/);
  assert.ok(logs.some((log) => log.tm_version));
});

test("Datadog content identifies the clinician on every click and keeps failures on their original patient page", async (t) => {
  const page = await browserHarness(t);
  // Wait for the real startup lookup to finish; only its network response is synthetic.
  await page.waitForFunction(() => ddClinician?.id === "42");
  await page.click("#lock");
  await page.click("#lock");
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent("error", {message: "Healthie failed", error: new TypeError("Healthie failed")}));
    window.dispatchEvent(new ErrorEvent("error", {message: "Healthie failed", error: new TypeError("Healthie failed")}));
    history.pushState({}, "", "/users/999/private_notes/edit/789");
    window.dispatchEvent(new ErrorEvent("error", {message: "Healthie failed", error: new TypeError("Healthie failed")}));
    window.dispatchEvent(new Event("pagehide"));
  });
  await page.click("#lock");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.equal(await page.locator("#result").textContent(), "native click handled");
  const logs = await page.evaluate(() => window.__logs);
  const clicks = logs.filter((entry) => entry.tm_kind === "chart-note");
  assert.equal(clicks.length, 3, "repeat clicks must remain separate events");
  assert.equal(clicks[0].message, "[INFO] [TM v2.6] Ada Lovelace <ada@vorihealth.com> (Healthie ID: 42) | [chart-note] clicked lock | path=/users/123/private_notes/edit/456");
  assert.match(clicks[2].message, /path=\/users\/999\/private_notes\/edit\/789$/);
  const failures = logs.filter((entry) => entry.tm_kind === "window");
  assert.equal(failures.length, 2, "each patient page needs its own failure");
  assert.equal(failures[0].message, "[ERROR] [TM v2.6] Ada Lovelace <ada@vorihealth.com> (Healthie ID: 42) | [window] window_error name=TypeError Healthie failed | path=/users/123/private_notes/edit/456 | repeats=2");
  assert.match(failures[1].message, /path=\/users\/999\/private_notes\/edit\/789$/);
  const startup = logs.find((entry) => entry.tm_kind === "lifecycle");
  assert.match(startup.message, /Ada Lovelace/);
  for (const log of [...clicks, ...failures]) {
    assert.equal(log.tm_version, "2.6");
    assert.equal(log.clinician_id, "42");
    assert.equal(log.clinician_identity_source, "healthie_browser_session");
    assert.ok(Number.isFinite(log.timestamp));
  }
});

for (const path of ["/", "/clients/active", "/appointments", "/settings/account", "/users/123/Overview", "/users/123/private_notes/edit/456"]) {
  test(`session clinician is available without API key or iframe on ${path}`, async (t) => {
    const page = await browserHarness(t, [], path);
    await page.waitForFunction(() => ddClinician?.id === "42", null, {timeout:5000});
    assert.equal(await page.locator("iframe").count(), 0);
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error", {message:"global page failure",error:new Error("global page failure")}));
      window.dispatchEvent(new Event("pagehide"));
    });
    const logs = await page.evaluate(() => window.__logs);
    const error = logs.find((entry) => entry.tm_kind === "window");
    assert.equal(error.clinician_id, "42");
    assert.equal(error.clinician_email, "ada@vorihealth.com");
    assert.equal(error.healthie_path, path);
    assert.equal(error.clinician_identity_source, "healthie_browser_session");
    assert.match(error.message, /Ada Lovelace.*Healthie ID: 42/);
    assert.ok(logs.some((entry) => entry.tm_kind === "lifecycle" && entry.tm_detail.includes("api_key=missing")));
    assert.ok(!JSON.stringify(logs).includes("synthetic-browser-session"));
  });
}

test("blocked telemetry transport leaves native fetch and charting clicks working", async (t) => {
  const page = await browserHarness(t);
  await page.evaluate(() => {
    window.GM_xmlhttpRequest = () => {
      throw new Error("extension disabled");
    };
  });
  await page.click("#lock");
  assert.equal(await page.locator("#result").textContent(), "native click handled");
  assert.equal(
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("pagehide"));
      return (await fetch("/graphql")).status;
    }),
    200
  );
  const result = await page.evaluate(() => window.__voriDatadogTest());
  assert.equal(result.accepted, false);
});
