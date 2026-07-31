# remote-agent-browser

Run [agent-browser](https://github.com/vercel-labs/agent-browser) in an isolated
[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox). Chromium and the CLI
come preinstalled, so there is no browser or Docker setup at runtime.

## Install

```bash
pnpm add remote-agent-browser
```

## Use

```ts
import { createAgentBrowser } from 'remote-agent-browser'

const browser = await createAgentBrowser()

try {
  const { results } = await browser.run([
    ['open', 'https://example.com'],
    ['snapshot', '-i', '--json'],
  ])

  console.log(results[1].stdout)
} finally {
  await browser.close()
}
```

`createAgentBrowser()` starts a fresh Vercel Sandbox from the prebuilt browser
image. Commands in one client share the same page, cookies, tabs, and element
references. `close()` closes Chromium and stops the Sandbox.

## Authentication

Authentication is automatic when running on Vercel through
`VERCEL_OIDC_TOKEN`.

For local development, link a Vercel project and pull its environment:

```bash
vercel link
vercel env pull .env.local
node --env-file=.env.local example.mjs
```

## API

### `createAgentBrowser()`

Starts a fresh browser in a disposable Vercel Sandbox. Always call
`browser.close()` when finished.

### `browser.run(commands)`

Run several agent-browser commands in the same session:

```ts
const result = await browser.run([
  ['open', 'https://my-preview.vercel.app'],
  ['wait', '--load', 'networkidle'],
  ['snapshot', '-i', '--json'],
  ['click', '@e3'],
])
```

### `browser.exec(command, options?)`

Run one command with arguments and flags:

```ts
await browser.exec('find', {
  args: ['role', 'button', 'click'],
  flags: { name: 'Submit' },
})
```

### Convenience methods

- `browser.snapshot(url)` opens a page and returns its interactive snapshot.
- `browser.screenshot(url, { fullPage: true })` returns a PNG buffer.
- `browser.close()` closes the session and stops the Sandbox.

All methods use the same disposable browser session until `close()` is called.

Container image and development details are in [docs.md](./docs.md).
