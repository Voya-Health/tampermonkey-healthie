const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const source = readFileSync("careplan.js", "utf8");

// Real browser APIs, synthetic page and extension APIs. No Healthie or Datadog requests leave the test.
async function browserHarness(t) {
  const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.url().includes("/graphql")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: { signNote: { messages: [{ field: "note", message: "private clinical text" }] } },
        }),
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<button id="sign">Sign and lock</button><button id="lock">Lock Note</button><output id="result"></output>',
    });
  });
  await page.goto("https://vorihealth.gethealthie.com/users/123/private_notes/edit/456");
  await page.evaluate(() => {
    window.__logs = [];
    window.unsafeWindow = window;
    window.GM_getValue = (_, fallback) => fallback;
    window.GM_setValue = () => {};
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
  assert.ok(!JSON.stringify(logs).includes("private clinical text"));
});

test("charting click and error observers retain native handlers and redact error contents", async (t) => {
  const page = await browserHarness(t);
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
  assert.ok(!/Jane|diagnosis|private chart|private rejection/.test(JSON.stringify(logs)));
});

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
