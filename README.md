# tampermonkey-healthie

Healthie integration with Tampermonkey.

Install test dependencies and Chromium, then run the request and browser tests:

```sh
npm ci
npx playwright install chromium
npm test
```

Run `npm run test:harness` to open the local React fixture at
http://127.0.0.1:4175/users/123/Overview. See [testing instructions](docs/testing.md)
for coverage, regression reproduction, and production checks.
