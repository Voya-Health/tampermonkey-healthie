const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../careplan.js"), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function load(name, overrides = {}) {
  const errors = [];
  const alerts = [];
  const writes = [];
  const context = {
    console: { error: (...args) => errors.push(args) },
    debugLog() {},
    location: { href: "https://vorihealth.gethealthie.com/users/123/Overview" },
    patientNumber: "123",
    isStagingEnv: false,
    healthieAPIKey: "",
    auth: "",
    mishaURL: "misha.vorihealth.com/",
    routeURLs: { providerSchedule: "provider-schedule" },
    GM_getValue: () => "",
    GM_setValue: (...args) => writes.push(args),
    alert: (message) => alerts.push(message),
    createTimeout() {},
    ...overrides,
  };
  for (const fn of ["reportHealthieRequestError", name]) {
    const match = source.match(new RegExp(`^function ${fn}\\([^]*?^}`, "m"));
    if (match) vm.runInNewContext(match[0], context);
  }
  return { context, errors, alerts, writes };
}

function provider(request) {
  const appended = [];
  const area = { childNodes: [] };
  return {
    ...load("waitAppointmentsHome", {
      initJQuery: () => () => ({ append: (iframe) => appended.push(iframe) }),
      document: { getElementsByClassName: () => [area], querySelector: () => null },
      generateIframe: (route) => route,
      healthieGQL: request,
    }),
    appended,
  };
}

for (const [label, response] of [
  ["network rejection", () => Promise.reject(new Error("network unavailable"))],
  ["malformed response", () => Promise.resolve({})],
]) {
  test(`provider appointments handles ${label} without inserting an iframe`, async () => {
    const fixture = provider(response);
    fixture.context.waitAppointmentsHome();
    await settle();
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.appended.length, 0);
  });
}

test("provider appointments still inserts the schedule iframe on success", async () => {
  const fixture = provider(() => Promise.resolve({ data: { user: { id: "456" } } }));
  fixture.context.waitAppointmentsHome();
  await settle();
  assert.deepEqual(fixture.appended, ["provider-schedule/456"]);
  assert.equal(fixture.errors.length, 0);
});

const carePlan = {
  goal: { title: "Overall goal" },
  milestones: [{ title: "Milestone", isVisible: true }],
  tasks: { tasks: [
    { contentfulId: "6nJFhYE6FJcnWLc3r1KHPR", items: [{ exercises: [
      { contentfulEntityId: "Exercise", side: "left" },
    ] }] },
    { title: "Regular task", isVisible: true },
  ] },
};

for (const [label, response] of [
  ["network rejection", () => Promise.reject(new Error("network unavailable"))],
  ["malformed response", () => Promise.resolve({})],
]) {
  test(`care plan handles goal lookup ${label} before sending mutations`, async () => {
    let requests = 0;
    const fixture = load("handleCarePlanTmInput", { healthieGQL: () => {
      requests++;
      return response();
    } });
    fixture.context.handleCarePlanTmInput(carePlan);
    await settle();
    assert.equal(fixture.errors.length, 1);
    assert.equal(requests, 1);
  });
}

for (const failedMutation of ["deleteGoal", "Milestone", "Overall goal", "Exercise - left", "Regular task"]) {
  test(`care plan reports a failed ${failedMutation} mutation and keeps independent requests`, async () => {
    const queries = [];
    const failure = new Error("mutation request failed");
    const fixture = load("handleCarePlanTmInput", { healthieGQL: (payload) => {
      const query = JSON.parse(payload).query;
      queries.push(query);
      if (query.includes(failedMutation)) return Promise.reject(failure);
      return Promise.resolve({ data: { goals: [{ id: "old-goal" }] } });
    } });
    fixture.context.handleCarePlanTmInput(carePlan);
    await settle();
    assert.equal(queries.length, 6);
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.errors[0][1], failure);
  });
}

test("care plan still sends all goal mutations on success", async () => {
  const queries = [];
  const fixture = load("handleCarePlanTmInput", { healthieGQL: (payload) => {
    queries.push(JSON.parse(payload).query);
    return Promise.resolve({ data: { goals: [{ id: "old-goal" }] } });
  } });
  fixture.context.handleCarePlanTmInput(carePlan);
  await settle();
  assert.equal(queries.filter((query) => query.includes("deleteGoal")).length, 1);
  assert.equal(queries.filter((query) => query.includes("createGoal")).length, 4);
  assert.equal(fixture.errors.length, 0);
});

function apiKey(request) {
  const input = { value: "" };
  const button = {};
  let reloads = 0;
  const fixture = load("waitSettingsAPIpage", {
    healthieGQL: request,
    document: { querySelector: (selector) => selector === ".api_keys" ? {} : {
      querySelector: (child) => child === "button" ? button : input,
    } },
    window: { location: { reload: () => reloads++ } },
  });
  fixture.context.waitSettingsAPIpage();
  input.value = "test-key";
  button.onclick();
  return { ...fixture, reloads: () => reloads };
}

for (const [label, response] of [
  ["network rejection", () => Promise.reject(new Error("network unavailable"))],
  ["malformed response", () => Promise.resolve(null)],
]) {
  test(`API key verification handles ${label} without saving or reloading`, async () => {
    const fixture = apiKey(response);
    await settle();
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.reloads(), 0);
    assert.deepEqual(fixture.alerts, ["Unable to verify the API key. Please try again."]);
  });
}

test("API key verification still saves and reloads on success", async () => {
  const fixture = apiKey(() => Promise.resolve({ data: { goals: [] } }));
  await settle();
  assert.deepEqual(fixture.writes, [["healthieApiKey", "test-key"]]);
  assert.equal(fixture.reloads(), 1);
  assert.deepEqual(fixture.alerts, ["API key saved successfully!"]);
  assert.equal(fixture.errors.length, 0);
});

test("API key verification still rejects GraphQL errors", async () => {
  const fixture = apiKey(() => Promise.resolve({ errors: [{ message: "Invalid key" }] }));
  await settle();
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.reloads(), 0);
  assert.deepEqual(fixture.alerts, ["That is not a valid API key. Please verify the key and try again."]);
});
