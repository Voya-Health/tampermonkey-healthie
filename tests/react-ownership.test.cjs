const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// Healthie's React keeps references to the nodes it rendered. Detaching one makes its next
// render fail on that node, which reaches clinicians as Healthie's own error page. The browser
// harness proves that for the handful of surfaces it models; this guard covers the rest of the
// file, where a new destructive call would otherwise ship unnoticed.

const sourcePath = process.env.HEALTHIE_TEST_SOURCE || path.join(__dirname, "../careplan.js");
const source = fs.readFileSync(sourcePath, "utf8");
const lines = source.split("\n");

function callSites(pattern) {
  return lines
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => pattern.test(text) && !text.startsWith("//"));
}

// These replace or detach whatever they are called on, so there is no safe way to point them at
// Healthie's markup. hideNativeNode and cloneNativeControl cover every case the script needs.
const banned = [
  [".empty()", /\.empty\(\)/],
  [".replaceWith()", /\.replaceWith\(/],
  [".detach()", /\.detach\(\)/],
  ["removeChild()", /\.removeChild\(/],
  ["replaceChild()", /\.replaceChild\(/],
];

for (const [name, pattern] of banned) {
  test(`careplan.js never calls ${name}`, () => {
    const found = callSites(pattern);
    assert.deepEqual(
      found,
      [],
      `${name} detaches whatever it is called on. Hide Healthie's node with hideNativeNode, ` +
        `or add a userscript-owned copy with cloneNativeControl, instead.`
    );
  });
}

// Nodes the userscript created itself, so removing or rewriting them cannot surprise React.
const ownedTargets = [
  // Containers, iframes and controls the script renders, all named misha-*.
  /misha-/,
  // Overlay dialog, cloned calendar and pediatric banner are built by the script.
  /\.overlay-dialog|\.cloned-calendar|pediatricBanner|\.pediatric-banner/,
  // jQuery elements built in place, for example $("<span>").
  /\$\("<[a-z]+>"\)/,
  // A detached copy is never part of Healthie's tree.
  /\.clone\(\)/,
  // Locals holding nodes the script created earlier in the same function.
  /\b(replacement|existingIframes|nestedIframes|instructions)\b/,
];

test("every destructive DOM call targets a node the userscript owns", () => {
  const unowned = callSites(/\.remove\(\)|\.innerHTML\s*=|\.html\(/)
    .filter(({ text }) => !ownedTargets.some((owned) => owned.test(text)));
  assert.deepEqual(
    unowned,
    [],
    "These detach or rewrite nodes Healthie's React may still be holding. Call hideNativeNode " +
      "to hide Healthie's markup, or cloneNativeControl to add a copy beside a native control. " +
      "If the target really is a node the script created, add it to ownedTargets."
  );
});

test("the non-destructive helpers stay available", () => {
  for (const helper of ["hideNativeNode", "cloneNativeControl"]) {
    assert.match(source, new RegExp(String.raw`^function ${helper}\(`, "m"), `${helper} is missing`);
  }
});
