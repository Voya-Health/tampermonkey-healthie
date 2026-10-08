# tampermonkey-healthie

Healthie integration with Tampermonkey.

Install test dependencies and Chromium, then run the request and browser tests:

```sh
npm ci --ignore-scripts
./node_modules/.bin/playwright install chromium
npm test
```

Run `npm run test:harness` to open the local React fixture at
http://127.0.0.1:4175/users/123/Overview. See [testing instructions](docs/testing.md)
for coverage, regression reproduction, and production checks.

## Datadog diagnostics

Version 2.6 reports errors and selected navigation, iframe, and chart-note actions to the US Datadog browser intake under `service:tampermonkey-healthie`. It observes page and userscript fetch, page XHR, console errors, window errors, and unhandled promise rejections. GraphQL failures include both top-level errors and Healthie mutation validation messages.

Logs contain static route names, HTTP status, error fingerprints, random installation/page IDs, and event counts. Dynamic URL segments, query values, raw error text, GraphQL payloads, and message contents are excluded. Error, warning, and information events have separate per-minute limits. Logging failures leave native requests and existing care-plan mutation behavior intact. The daily probe records its timestamp only after intake acceptance.

For a manual intake check in the Healthie page console, run:

```js
await window.__voriDatadogTest()
```

Use the returned `test_id` to search Datadog with `service:tampermonkey-healthie @test_id:<value>`. `accepted: true` confirms an HTTP success response from intake; confirm the event appears in Datadog separately. This diagnostic sends synthetic data. It does not reproduce or fix the intermittent note-locking issue.

Run `npm run test:telemetry-browser` for the three Datadog browser checks alone.
To use installed Google Chrome for those checks, set `BROWSER_CHANNEL=chrome`.
`npm test` runs both the Datadog and Healthie regression suites.
