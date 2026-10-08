const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const sourcePath = process.env.HEALTHIE_TEST_SOURCE || path.join(__dirname, "../../careplan.js");
const reactRoot = path.dirname(require.resolve("react/package.json"));
const reactDomRoot = path.dirname(require.resolve("react-dom/package.json"));
const assets = new Map([
  ["/harness.js", path.join(__dirname, "harness.js")],
  ["/extension-api.js", path.join(__dirname, "extension-api.js")],
  ["/vendor/jquery.js", require.resolve("jquery/dist/jquery.js")],
  ["/vendor/react.js", path.join(reactRoot, "umd/react.development.js")],
  ["/vendor/react-dom.js", path.join(reactDomRoot, "umd/react-dom.development.js")],
]);

function extract(source, pattern, name) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Missing production declaration: ${name}`);
  return match[0];
}

function userscriptUnderTest() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const functions = ["debugLog", "createTimeout", "initJQuery", "convertToCSSProperty",
    "generateIframe", "hideOverlay", "showOverlay", "waitAppointmentsProfile", "handleAppointmentsProfileRoute",
    "createPatientDialogIframe", "waitForAddPatientButton"];
  const declarations = functions.map((name) =>
    extract(source, new RegExp(String.raw`^function ${name}\([^]*?^}`, "m"), name));
  // Earlier revisions lack these helpers; source overrides must still reproduce their failure.
  for (const name of ["findAddClientButton", "handleAddClientClick"]) {
    const match = source.match(new RegExp(String.raw`^function ${name}\([^]*?^}`, "m"));
    if (match) declarations.push(match[0]);
  }
  for (const name of ["routeURLs", "styles"]) {
    declarations.unshift(extract(source, new RegExp(String.raw`^const ${name} = \{[^]*?^};`, "m"), name));
  }
  declarations.unshift(extract(source, /^const isStagingEnv = .+;$/m, "isStagingEnv"),
    extract(source, /^let mishaURL = .+;$/m, "mishaURL"));
  // Load the actual telemetry declarations when present, including iframe observers.
  // Older source overrides omit telemetry so they can still reproduce DOM regressions.
  const telemetryStart = source.indexOf('const TM_VERSION =');
  const telemetryEnd = source.indexOf('const routeURLs =');
  const telemetry = telemetryStart >= 0
    ? source.slice(telemetryStart, telemetryEnd)
    : "";
  const setup = telemetry ? "\nsetupHealthieDatadogLogs();" : "";
  return `let debug = false; let timeoutIds = [];\n${telemetry}\n${declarations.join("\n")}${setup}`;
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("Cache-Control", "no-store");
  try {
    if (pathname === "/userscript-under-test.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(userscriptUnderTest());
    } else if (assets.has(pathname)) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(fs.readFileSync(assets.get(pathname)));
    } else if (pathname === "/" || pathname === "/clients/active" || /^\/users\/\d+(?:\/Overview)?$/.test(pathname)) {
      response.setHeader("Content-Type", "text/html");
      response.end(fs.readFileSync(path.join(__dirname, "index.html")));
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error("Test harness failed to load", error);
    response.writeHead(500).end("Test harness failed to load");
  }
});

server.listen(4175, "127.0.0.1", () => {
  console.log("Healthie test harness: http://127.0.0.1:4175/users/123/Overview");
});
