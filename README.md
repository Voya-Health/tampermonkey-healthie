# tampermonkey-healthie

Healthie integration with Tampermonkey.

## Datadog diagnostics

Version 2.5 reports errors and selected navigation, iframe, and chart-note actions to the US Datadog browser intake under `service:tampermonkey-healthie`. It observes page and userscript fetch, page XHR, console errors, window errors, and unhandled promise rejections. GraphQL failures include both top-level errors and Healthie mutation validation messages.

Logs contain static route names, HTTP status, error fingerprints, random installation/page IDs, and event counts. Dynamic URL segments, query values, raw error text, GraphQL payloads, and message contents are excluded. Error, warning, and information events have separate per-minute limits. Logging failures leave native requests and existing care-plan mutation behavior intact. The daily probe records its timestamp only after intake acceptance.

For a manual intake check in the Healthie page console, run:

```js
await window.__voriDatadogTest()
```

Use the returned `test_id` to search Datadog with `service:tampermonkey-healthie @test_id:<value>`. `accepted: true` confirms an HTTP success response from intake; confirm the event appears in Datadog separately. This diagnostic sends synthetic data. It does not reproduce or fix the intermittent note-locking issue.

## Tests

Node.js 22 or newer:

```sh
npm ci
npm test
npx playwright-core install chromium
npm run test:browser
```

To use installed Google Chrome, run `BROWSER_CHANNEL=chrome npm run test:browser`.

The Node tests execute the full userscript with simulated extension APIs. The browser tests use native fetch, XHR, and DOM events with synthetic pages and intercepted requests. They do not call Healthie or Datadog and do not establish live Tampermonkey-extension or signed-in Healthie compatibility. CI runs both suites.
