# Testing the Healthie userscript

Use Node 22 or later. Install the locked dependencies and Chromium:

```sh
npm ci --ignore-scripts
./node_modules/.bin/playwright install chromium
npm test
```

`npm test` runs 52 Node tests for Datadog diagnostics and GraphQL request handling,
then 10 native Chromium telemetry tests and 19 Playwright tests for patient Overview
appointments and Add client. GitHub Actions runs all suites on each PR and saves Playwright reports, traces, and failure
screenshots as the `playwright-results` artifact. Check the latest commit's
`Userscript tests` job and SonarCloud result before completing a PR.

## Browser coverage

The fixture uses React 18 and jQuery from locked local dependencies. The server
reads `careplan.js` for each request and extracts the actual appointments route, Add client handlers,
polling, iframe, and overlay functions with their URL and style declarations.
The fixture also loads the actual Datadog declarations and installs their page
observers. It simulates extension storage and Datadog transport without contacting
the intake service. Missing declarations fail the fixture load. Tests do not maintain a separate
implementation of those functions.

Playwright checks:

- Both `/users/123` and `/users/123/Overview`, modern contents markup, and legacy fallback.
- Stable button test IDs, SVG titles, exact labels, and unrelated section controls.
- Delayed contents and tabs, repeated injection, and cloned dynamic ID removal.
- The appointments iframe URL, visible Add appointment control, schedule URL,
  overlay close behavior, and suppression of native and bubbled schedule clicks.
- Real React refresh, restore, navigation to patient 456, and unmount after injection.
- Staging's route guard, which skips the production appointments replacement.
- Add client from legacy, `.add-client-container`, and button markup without test IDs;
  native click and press prevention, React refresh/restore/unmount, icon and keyboard clicks,
  repeated setup, hidden duplicate controls, delayed rendering, and staging URLs.

Each browser test fails on uncaught page errors or unexpected external requests.
The React fixture displays browser errors in its HTML so manual checks also expose
reconciliation failures. Tests intercept Misha iframe requests and return synthetic
HTML while checking the actual production URLs. They do not contact patient APIs.

The Datadog Node suite checks full paths, clinician identity, error text, bounded logging, storage and
transport failures, daily probes, HTTP/GraphQL observers, independent goal requests,
and alignment of the userscript update header with the emitted telemetry version.
The ten native browser tests execute the full userscript with simulated extension
APIs and intercepted requests. They check fetch/XHR response preservation, native
sign/lock click handlers, and isolation of transport failures, including a failed
manual diagnostic result. They also verify the clinician and version in Content,
each repeated click, and separate failures after patient navigation. They fail on
uncaught browser errors, unexpected console errors, and failed or unexpected requests.
The console observer test expects only the error it injects. Request error unit tests
isolate their callers and stub telemetry collaborators, which the Datadog suite
checks separately. All fixtures use synthetic data; these checks do not prove that
Datadog indexes logs or that Healthie fixes intermittent note locking.

## Datadog Content

Each event's `message` includes severity, script version, clinician identity,
event detail, and the path at the time of the event. For example, with synthetic data:

```text
[INFO] [TM v2.6] Ada Lovelace <ada@vorihealth.com> (Healthie ID: 42) | [chart-note] clicked sign and lock | path=/users/123/private_notes/edit/456
[ERROR] [TM v2.6] Ada Lovelace <ada@vorihealth.com> (Healthie ID: 42) | [window] TypeError: Cannot read id | path=/users/123/private_notes/edit/456 | repeats=4
```

Identity comes from Healthie's authenticated browser session through `currentUser`.
The lookup runs globally, independent of route, Misha iframes, and the saved
userscript API key. It reads Healthie's `blog:token` and `blog:source` from
localStorage, with sessionStorage as a fallback, and makes a read-only request
to the matching Healthie API using Bearer authentication. The session token stays
in memory and request headers. `clinician_identity_source` records
`healthie_browser_session`; the API key owner is never a viewer fallback.

Normal batches, daily probes, and manual diagnostics wait for identity resolution,
up to a ten-second deadline. Missing, expired, blocked, malformed, or patient
sessions show `Clinician unavailable`. Failed lookups retry after a 30-second
cooldown when another event or focus check occurs. The script checks the session
before each event and on storage/focus changes. A session change clears the old
clinician and ignores late responses from the previous session. Queued events
pick up identity only within their original session context; their path and any
identity already assigned remain unchanged. A forced pagehide flush may send an
unresolved event as `Clinician pending` rather than assign a different user.

The browser fixtures verify the actual startup lookup on Home, Clients, Calendar,
Settings, Overview, and chart-note routes with no iframe and no userscript API
key. Unit tests cover a shared API key owned by a different person, localStorage
and sessionStorage, account switching, stale responses, logout, patient identities,
expired/malformed responses, timeout, and bounded retry.

Live staging verification on October 15, 2026 executed the actual source telemetry
declarations in an isolated scope on Home, Clients, Calendar, Settings, and a chart
page. Each returned the signed-in clinician's Healthie ID, name, and email using
the browser session with no userscript API key in that scope. This verifies the
identity lookup against Healthie's real API. It does not establish installation
of the PR's full userscript, production compatibility, or live Datadog indexing.

Structured clinician fields, `tm_version`, `tm_kind`, `tm_severity`, and
`healthie_path` remain available for filtering. `tm_detail` keeps the event detail
apart from the display prefix. `timestamp` records the first occurrence in Unix
milliseconds; `last_seen_at` records the latest captured repeat. Detail has a
500-character limit. Content bounds error detail and identity separately so a long
error cannot remove the clinician or path. Both Content and `healthie_path` retain
the full path, including paths longer than 500 characters; Node and Chromium
regressions check this for actions and errors.
Query strings and the API key value stay out of URL attributes.

Info events retain individual actions within the existing 30-per-minute limit.
A click means the clinician clicked a control; it does not establish that Healthie
completed the action. Warnings and errors collapse by severity, kind, original
message, path, and clinician context. They send after two quiet seconds or after
30 seconds of continuous repeats, with `repeat_count` and a visible `repeats=N`
suffix. Later copies of that failure in the same context are suppressed for the
page session. The warning and error limits remain 20 each per minute. External
401s are still dropped; Healthie 401s remain.

To reproduce the Content and repeat-click regressions against PR #133's earlier
implementation, keep the current tests and run:

```sh
mkdir -p .test-fixtures
git show d21bc55:careplan.js > .test-fixtures/before-readable-content.js
USERSCRIPT_PATH=.test-fixtures/before-readable-content.js node --test tests/datadog.test.cjs
USERSCRIPT_PATH=.test-fixtures/before-readable-content.js node --test --test-name-pattern='Datadog content identifies' tests/datadog.browser.cjs
```

The old code fails the Content and repeat-click regressions. The browser regression receives one
click event instead of three. Run `npm test` against the current source to verify
the fix. Local failed-run evidence stays under `.test-fixtures/`.

To reproduce the missing browser-session identity against the earlier key-owner
implementation, use the current tests with:

```sh
git show 021cf37:careplan.js > .test-fixtures/before-session-viewer.js
USERSCRIPT_PATH=.test-fixtures/before-session-viewer.js node --test --test-name-pattern='browser session identifies|shared API key|session switches|session lookup rejects|lookup timeout' tests/datadog.test.cjs
USERSCRIPT_PATH=.test-fixtures/before-session-viewer.js node --test --test-name-pattern='session clinician.*on /clients/active$' tests/datadog.browser.cjs
```

The five Node regressions fail there. The browser regression times out waiting
for a clinician, because the old code ignores the browser session.

This harness covers the changed appointments and Add client features and request handling. It does
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

Open http://127.0.0.1:4175/clients/active?clients=1 to exercise Add client.
Use `layout=legacy` or `layout=bare` query options for alternative markup.
Inject Add client installs the actual click interception; Refresh and Restore
replace the native React button without reinstalling the handlers.

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

To reproduce the Add client failures from the previous PR revision:

```sh
git show 7056292:careplan.js > .test-fixtures/broken-add-client.js
HEALTHIE_TEST_SOURCE="$PWD/.test-fixtures/broken-add-client.js" \
  ./node_modules/.bin/playwright test add-client.spec.cjs
```

The old handler fails to open Misha for the supported `.add-client-container`
path or a button without test IDs, and replacing the legacy React button
breaks refresh. The fixed handler uses idempotent document capture handlers,
re-evaluates the visible control on each click, and preserves the native DOM.

## Production acceptance

On a production Healthie patient Overview, verify the Misha appointments iframe
loads, Add appointment remains visible, and clicking it opens the schedule for
that patient. Refresh or navigate away and confirm no React reconciliation error.
These checks need a signed-in Healthie session and access to Misha. Report them
separately from local fixture results. Staging skips this path and cannot establish
production acceptance.

On the Clients list, verify Add client opens Misha's `createPatientDialog`
instead of Healthie's native dialog. Re-render the Clients list and verify it
still opens once. Add client uses the staging Misha URL on staging.

Assign one userscript version above the PR base and retain it across review fixes.
PR #134 shipped `2.5`. PR #133 uses `2.6`, above the current `main` version `2.5`;
its Datadog `TM_VERSION` must match the userscript header.
