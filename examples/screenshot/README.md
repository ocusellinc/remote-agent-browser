# Capture a screenshot

This example starts a remote browser, captures a full-page screenshot, saves
the PNG locally, and closes the browser Sandbox.

After completing the authentication setup in the [project README](../../README.md#authentication),
run:

```bash
node --env-file=.env.local examples/screenshot/index.mjs
```

The default URL is `https://example.com` and the default output path is
`screenshot.png`. Pass a URL and output path to override them:

```bash
node --env-file=.env.local examples/screenshot/index.mjs \
  https://vercel.com \
  vercel.png
```

See [`index.mjs`](./index.mjs) for the complete example.
