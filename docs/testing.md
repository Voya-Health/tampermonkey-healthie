# Testing the Healthie userscript

Use Node 20 or later. Install the locked dependencies and Chromium:

```sh
npm ci --ignore-scripts
./node_modules/.bin/playwright install chromium
npm test
```

`npm test` runs 15 Node tests for GraphQL request handling, then 12 Chromium
Playwright tests for the patient Overview appointments integration. GitHub Actions
runs both suites on each PR and saves Playwright reports, traces, and failure
screenshots as the `playwright-results` artifact. Check the latest commit's
`Userscript tests` job and SonarCloud result before completing a PR.

## Browser coverage

The fixture uses React 18 and jQuery from locked local dependencies. The server
reads `careplan.js` for each request and extracts the actual appointments route,
polling, iframe, and overlay functions with their URL and style declarations.
Missing declarations fail the fixture load. Tests do not maintain a separate
implementation of those functions.

Playwright checks:

- Both `/users/123` and `/users/123/Overview`, modern contents markup, and legacy fallback.
- Stable button test IDs, SVG titles, exact labels, and unrelated section controls.
- Delayed contents and tabs, repeated injection, and cloned dynamic ID removal.
- The appointments iframe URL, visible Add appointment control, schedule URL,
  overlay close behavior, and suppression of native and bubbled schedule clicks.
- Real React refresh, restore, navigation to patient 456, and unmount after injection.
- Staging's route guard, which skips the production replacement.

Each browser test fails on uncaught page errors or unexpected external requests.
The React fixture displays browser errors in its HTML so manual checks also expose
reconciliation failures. Tests intercept Misha iframe requests and return synthetic
HTML while checking the actual production URLs. They do not contact patient APIs.

This harness covers the changed appointments feature and request handling. It does
not execute the entire userscript router or every unrelated integration. React 18
fixtures do not establish compatibility with all future Healthie markup. Extend
the fixture and tests when a change affects another integration.

## Manual local harness

```sh
npm run test:harness
```

Open http://127.0.0.1:4175/users/123/Overview. Use Inject appointments, Refresh,
Restore, and Unmount to exercise the actual source functions against React-owned
markup. Next patient verifies replacement and schedule routing for patient 456.
The error panel must remain empty. The manual harness uses actual Misha URLs;
Playwright mocks those responses during automated tests.

Query options include `?layout=legacy`, `?layout=both`, `?buttonTestId=1`,
`?pendingRoot=1`, `?pendingTabs=1`, and `?environment=securestaging`.
Use Load Overview to complete delayed rendering. Restarting the server is not
necessary after editing `careplan.js`; reload the page to read the new source.

Run `npm run test:browser:ui` for Playwright's interactive runner, or
`./node_modules/.bin/playwright show-report` to inspect the latest report.

## Prove the React regression test catches the original crash

The server accepts a source override for regression reproduction. Run it against
the earlier broken PR revision without editing the current userscript:

```sh
mkdir -p .test-fixtures
git show b80a4cb:careplan.js > .test-fixtures/broken-careplan.js
HEALTHIE_TEST_SOURCE="$PWD/.test-fixtures/broken-careplan.js" \
  ./node_modules/.bin/playwright test --grep 'React can refresh'
```

Expect failure with `removeChild` / `NotFoundError` when React refreshes after the
script removes React-owned nodes. Then run `npm test` without the source override;
the fixed version must pass. Keep failure logs out of source control. Do not weaken
the browser error assertions or hide native tree failures.

## Production acceptance

On a production Healthie patient Overview, verify the Misha appointments iframe
loads, Add appointment remains visible, and clicking it opens the schedule for
that patient. Refresh or navigate away and confirm no React reconciliation error.
These checks need a signed-in Healthie session and access to Misha. Report them
separately from local fixture results. Staging skips this path and cannot establish
production acceptance.

Assign one userscript version above the PR base and retain it across review fixes.
PR #134 uses `2.5`, compared with `2.4` on its base.
