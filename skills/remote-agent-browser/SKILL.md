---
name: remote-agent-browser
description: Drive a real remote Chromium browser over plain HTTP to load, inspect, interact with, and screenshot any URL — no Playwright, CDP, or local browser needed. Use when you need to verify a deployed page works (preview deployments, sandboxes), read rendered content from a live site, automate form interactions, capture screenshots/PDFs, or collect console errors and Core Web Vitals from a real browser.
---

# remote-agent-browser

A hosted browser-automation API. Each request runs [agent-browser](https://github.com/vercel-labs/agent-browser) commands against an isolated Chromium session and returns the results as JSON (or raw image/PDF bytes).

## Setup

- **Base URL**: the service deployment, e.g. `https://remote-agent-browser.vercel.app` (ask the user for theirs, or read `REMOTE_AGENT_BROWSER_URL` from the environment).
- **Trusted Sources deployments**: if the service sits behind Vercel Deployment Protection with Trusted Sources, also send `x-vercel-trusted-oidc-idp-token: <token>` — from a Vercel function use `await getVercelOidcToken()` (`@vercel/oidc`); a 401/SSO-redirect HTML response instead of JSON means this header is missing or the caller isn't on the allowlist.
- All request bodies are JSON: `content-type: application/json`.

## The one rule that matters

**Put an entire task into a single `/run` request.** Instances are stateless between requests: element refs (`@e1`) from a snapshot, open pages, and cookies are only guaranteed to exist within the request that created them. A follow-up request may land on a different instance with no browser state.

Wrong (refs die between requests):
```
POST /run  {"commands": [["open", URL], ["snapshot", "-i"]]}   → returns @e5
POST /run  {"commands": [["click", "@e5"]]}                     → @e5 may not exist
```

Right (snapshot → act → verify, all in one batch — or use CSS selectors / `find`, which don't need a prior snapshot):
```
POST /run  {"commands": [
  ["open", URL],
  ["fill", "input[name=email]", "a@b.co"],
  ["find", "role", "button", "click", "--name", "Submit"],
  ["wait", "1000"],
  ["get", "url"],
  ["errors"]
]}
```

If you genuinely need to look at a snapshot before deciding what to click, do two passes: request 1 opens + snapshots; request 2 re-opens and acts using **stable selectors** (CSS, roles, text) instead of refs.

## Endpoints

### `POST /run` — the workhorse

```json
{
  "commands": [["open", "https://example.com"], ["get", "title"]],
  "stopOnError": true,          // optional, default true
  "session": "sandbox-42"       // optional; omit for auto-isolated ephemeral session
}
```

Response (`200` if all succeeded, `422` if any failed, `400` on malformed input):

```json
{
  "results": [
    { "command": "agent-browser --session req-… open https://example.com",
      "ok": true, "exitCode": 0,
      "stdout": "✓ Example Domain\n  https://example.com/\n", "stderr": "" }
  ],
  "session": "req-…"
}
```

Parse `results[i].stdout` for output; on failure check `results[i].stderr`. With `stopOnError: true`, `results` is truncated at the first failure.

### `POST /snapshot` — one-shot accessibility tree

`{"url": "https://example.com"}` → agent-browser's JSON snapshot of interactive elements with refs, roles, and names. Use this to *read* what's on a page.

### `POST /screenshot` — one-shot PNG

`{"url": "https://example.com", "fullPage": true}` → `image/png` bytes. `fullPage` is optional.

### `POST /commands/<name>` — single command

```json
{ "args": ["role", "button", "click"], "flags": {"name": "Submit"}, "session": "sandbox-42" }
```

`args` = positional CLI args. `flags` = object serialized to `--kebab-case` flags (`true` → bare flag, arrays → repeated). Without `session`, single commands share the instance's default session — prefer `/run` batches instead.

File-producing commands return raw bytes instead of JSON when you don't pass a path: `screenshot` (`image/png`, or `image/jpeg` with `"flags": {"screenshotFormat": "jpeg"}`), `pdf` (`application/pdf`), `trace stop` / `profiler stop` (`application/json`), `record stop` (`video/webm`).

### `GET /commands` — discovery

Returns every supported command with a one-line description. Supported: `open read click dblclick type fill press keyboard hover focus check uncheck select drag upload download scroll scrollintoview wait screenshot pdf snapshot eval close back forward reload pushstate get is find mouse set network cookies storage state tab diff trace profiler record console errors highlight clipboard react vitals removeinitscript batch session skills doctor`. Anything else is rejected with `400`/`404`.

### `GET /healthz`

`{"ok": true}` — liveness only; does not prove Chromium works. To verify the full chain, run a `/run` batch against `https://example.com`.

## Command quick reference

| Goal | Commands |
|---|---|
| Load a page | `["open", url]` — waits for load; add `["wait", "1000"]` for late-hydrating apps |
| Read structure | `["snapshot", "-i"]` (interactive elems + refs), `["read"]` (page text) |
| Read specifics | `["get", "title"]`, `["get", "url"]`, `["get", "text", sel]`, `["get", "value", sel]`, `["get", "count", sel]` |
| Interact | `["click", sel]`, `["fill", sel, text]`, `["type", sel, text]`, `["press", "Enter"]`, `["check", sel]`, `["select", sel, value]`, `["scroll", "down", "500"]` |
| Find without snapshot | `["find", "role", "button", "click", "--name", "Submit"]` — also `text`, `label`, `placeholder`, `testid` |
| Assert state | `["is", "visible", sel]`, `["is", "enabled", sel]`, `["is", "checked", sel]` → stdout `true`/`false` |
| Wait | `["wait", sel]` (element) or `["wait", "2000"]` (ms) |
| Debug a page | `["console"]`, `["errors"]`, `["network", "requests"]`, `["vitals"]` |
| Run JS | `["eval", "document.title"]` → stdout is the result (strings come back JSON-quoted: `"foo"`) |
| Read attribute | `["get", "attr", sel, name]` — selector before attribute name |
| Emulate | `["set", "viewport", "390", "844"]`, `["set", "media", "dark"]` |

Selectors: CSS (`input[name=email]`), refs from a same-request snapshot (`@e3`), or `find` semantic locators. Add `--json` to most commands for machine-readable stdout.

## Recipes

**Smoke-test a preview deployment** (the common case — did it deploy, render, and stay error-free?):

```json
{"commands": [
  ["open", "https://my-app-git-branch.vercel.app"],
  ["wait", "1500"],
  ["get", "title"],
  ["snapshot", "-i", "-d", "3"],
  ["console"],
  ["errors"],
  ["vitals"]
]}
```

Pass criteria: every `ok: true`, `errors` stdout empty, title is not an error page.

**Visual check**: `POST /screenshot {"url": ..., "fullPage": true}` → attach/inspect the PNG.

**Form flow with verification**:

```json
{"commands": [
  ["open", url],
  ["fill", "input[name=q]", "hello"],
  ["press", "Enter"],
  ["wait", "1000"],
  ["get", "url"],
  ["get", "text", "h1"]
]}
```

**Many URLs in parallel**: fire one `/run` request per URL concurrently — each gets an isolated browser session; no interference. Scale-out is automatic.

**Multi-request stateful session** (only when a single batch can't work): pass the same `"session": "name"` on each request, and `POST /commands/close {"session": "name"}` when done. Caveat: state survives only while requests hit the same warm instance — treat loss as possible and re-`open` defensively.

## Errors, timing, limits

- `401`/SSO-redirect HTML: blocked by Deployment Protection — missing or unauthorized `x-vercel-trusted-oidc-idp-token` · `400` malformed body or unsupported command · `422` a browser command failed (inspect `results`) · `500` service error.
- Cold start: first request after ~5 idle minutes takes a few seconds extra (instance boot + Chromium launch). Retry once on timeout before concluding the target is broken.
- Per-command timeout 60s; page-action default timeout 25s; request bodies max 1MB. Very large snapshots are capped at 32MB.
- The browser exits with the request (ephemeral sessions) — nothing to clean up.

## Integration snippet (JS)

```js
const BASE = process.env.REMOTE_AGENT_BROWSER_URL

async function browse(commands, opts = {}) {
  const res = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands, ...opts }),
  })
  const { results } = await res.json()
  if (!res.ok) {
    const failed = results?.findLast((r) => !r.ok)
    throw new Error(`${failed?.command}: ${failed?.stderr || failed?.stdout}`)
  }
  return results.map((r) => r.stdout.trim())
}

// usage
const [, title, errors] = await browse([
  ['open', 'https://my-preview.vercel.app'],
  ['get', 'title'],
  ['errors'],
])
```
