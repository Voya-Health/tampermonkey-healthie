const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function loadHelpers() {
  const src = fs.readFileSync(path.join(__dirname, "careplan.js"), "utf8");
  const start = src.indexOf("// BEGIN chart-note-navigation");
  const end = src.indexOf("// END chart-note-navigation");
  if (start === -1 || end === -1) {
    throw new Error("chart-note-navigation helpers missing from careplan.js");
  }
  return vm.runInThisContext(
    `${src.slice(start, end)}\n({\n  parseChartNoteRef,\n  buildChartNoteEditUrl,\n  navigateToChartNote,\n  bindMishaMessageListener,\n  resolveTopWindow\n});`
  );
}

const helpers = loadHelpers();
const careplanSrc = fs.readFileSync(path.join(__dirname, "careplan.js"), "utf8");

test("parses noteId and patientId at the first hyphen", () => {
  assert.deepEqual(helpers.parseChartNoteRef("12345678-388687"), {
    noteId: "12345678",
    patientId: "388687",
  });
});

test("keeps extra hyphens in the patient segment", () => {
  assert.deepEqual(helpers.parseChartNoteRef("123-patient-456"), {
    noteId: "123",
    patientId: "patient-456",
  });
});

test("rejects payloads that cannot be split into two ids", () => {
  assert.equal(helpers.parseChartNoteRef("123456"), null);
  assert.equal(helpers.parseChartNoteRef("-388687"), null);
  assert.equal(helpers.parseChartNoteRef("12345678-"), null);
  assert.equal(helpers.parseChartNoteRef(null), null);
});

test("builds the Healthie chart note editor URL", () => {
  assert.equal(
    helpers.buildChartNoteEditUrl("securestaging.gethealthie.com", "99-88"),
    "https://securestaging.gethealthie.com/users/88/private_notes/edit/99"
  );
});

test("uses location.assign on the top window", () => {
  const assigned = [];
  const topWin = { location: { assign: (url) => assigned.push(url) } };
  const url = "https://securestaging.gethealthie.com/users/88/private_notes/edit/99";

  assert.equal(helpers.navigateToChartNote(topWin, url), true);
  assert.deepEqual(assigned, [url]);
});

test("addEventListener still runs after window.onmessage is overwritten", () => {
  const target = new EventTarget();
  const received = [];
  const handler = (event) => received.push(event.data);

  assert.equal(helpers.bindMishaMessageListener(target, handler), true);
  assert.equal(helpers.bindMishaMessageListener(target, handler), false);

  target.onmessage = () => {
    throw new Error("onmessage overwrite should not replace addEventListener");
  };
  target.dispatchEvent(new MessageEvent("message", { data: { newChartNoteId: "1-2" } }));

  assert.deepEqual(received, [{ newChartNoteId: "1-2" }]);
});

test("prefers the page top window over the sandbox window", () => {
  const sandboxTop = { id: "sandbox" };
  const pageTop = { id: "page" };
  assert.equal(helpers.resolveTopWindow({ top: sandboxTop }, { top: pageTop }), pageTop);
});

test("careplan.js binds Misha messages with addEventListener, not window.onmessage", () => {
  const waitForStart = careplanSrc.indexOf("function waitForMishaMessages()");
  const waitForEnd = careplanSrc.indexOf("function waitSettingsAPIpage()");
  const waitForBody = careplanSrc.slice(waitForStart, waitForEnd);

  assert.match(waitForBody, /bindMishaMessageListener\(\s*window,/);
  assert.doesNotMatch(waitForBody, /window\.onmessage\s*=/);
  assert.match(careplanSrc, /target\.addEventListener\(\s*["']message["']/);
});

test("careplan.js opens newChartNoteId with location.assign, not window.open", () => {
  const noteStart = careplanSrc.indexOf("event.data.newChartNoteId");
  const noteEnd = careplanSrc.indexOf("event.data.patientGroupName");
  const noteBody = careplanSrc.slice(noteStart, noteEnd);

  assert.match(noteBody, /navigateToChartNote|location\.assign/);
  assert.doesNotMatch(noteBody, /window\.open/);
});

test("careplan.js parses as valid JavaScript", () => {
  new Function(careplanSrc);
});
