# mini-remote-browser

A remote browser service: [agent-browser](https://github.com/vercel-labs/agent-browser) + Chromium wrapped in a tiny HTTP API, deployed on Vercel via a [Dockerfile](https://vercel.com/blog/dockerfile-on-vercel).

> **Integrating this into an app or agent?** Use the agent-facing usage guide at [`skills/mini-remote-browser/SKILL.md`](./skills/mini-remote-browser/SKILL.md) — copy it into your agent's skills directory (e.g. `.claude/skills/mini-remote-browser/`) or paste it into a system prompt. It's self-contained: endpoints, request/response shapes, session semantics, recipes, and pitfalls.

## Deploy

```bash
vercel deploy
```

That's it — Vercel detects `Dockerfile.vercel`, builds the image, pushes it to Vercel Container Registry, and routes all traffic to the container.

To require auth, set an `AUTH_TOKEN` environment variable in the project settings; clients must then send `Authorization: Bearer <token>`. Recommended, since the service will browse arbitrary URLs on behalf of callers.

## API

### `GET /commands`

Lists every supported agent-browser command with a one-line description. The service covers the full page-facing CLI surface: `open`, `read`, `click`, `dblclick`, `type`, `fill`, `press`, `keyboard`, `hover`, `focus`, `check`, `uncheck`, `select`, `drag`, `upload`, `download`, `scroll`, `scrollintoview`, `wait`, `screenshot`, `pdf`, `snapshot`, `eval`, `close`, `back`, `forward`, `reload`, `pushstate`, `get`, `is`, `find`, `mouse`, `set`, `network`, `cookies`, `storage`, `state`, `tab`, `diff`, `trace`, `profiler`, `record`, `console`, `errors`, `highlight`, `clipboard`, `react`, `vitals`, `removeinitscript`, `batch`, `session`, `skills`, `doctor`.

Deliberately excluded: system/lifecycle commands (`install`, `upgrade`, `dashboard`, `profiles`, `plugin`, `auth`), interactive ones (`chat`, `mcp`, `inspect`, `confirm`/`deny`), and ones needing extra ports (`connect`, `stream` — only `$PORT` is routed on Vercel).

### `POST /commands/<name>`

Run one command. `args` are positional CLI args; `flags` is an object serialized to `--kebab-case` flags (`true` → bare flag, arrays → repeated flag).

```bash
curl -X POST https://<deployment>/commands/snapshot \
  -H 'content-type: application/json' \
  -d '{"flags": {"interactive": true, "json": true}}'

curl -X POST https://<deployment>/commands/find \
  -H 'content-type: application/json' \
  -d '{"args": ["role", "button", "click"], "flags": {"name": "Submit"}}'
```

File-producing commands (`screenshot`, `pdf`, `trace stop`, `profiler stop`, `record stop`) return the file bytes directly (`image/png`, `application/pdf`, …) when you don't pass an output path yourself:

```bash
curl -X POST https://<deployment>/commands/pdf \
  -H 'content-type: application/json' -d '{}' --output page.pdf

curl -X POST https://<deployment>/commands/screenshot \
  -H 'content-type: application/json' \
  -d '{"flags": {"full": true, "screenshotFormat": "jpeg"}}' --output page.jpg
```

### `POST /run`

Execute a batch of agent-browser commands in order. Each command is an array of CLI args (no shell involved).

```bash
curl -X POST https://<deployment>/run \
  -H 'content-type: application/json' \
  -d '{
    "commands": [
      ["open", "https://example.com"],
      ["snapshot", "-i", "--json"],
      ["get", "text", "@e1"]
    ]
  }'
```

Returns `{ results: [{ command, ok, exitCode, stdout, stderr }] }`. Execution stops at the first failure unless `"stopOnError": false` is set. Every command is validated against the same allowlist as `/commands/<name>`.

### `POST /snapshot`

Open a URL and return its interactive accessibility snapshot as JSON.

```bash
curl -X POST https://<deployment>/snapshot \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com"}'
```

### `POST /screenshot`

Open a URL and return a PNG. Accepts optional `"fullPage": true`.

```bash
curl -X POST https://<deployment>/screenshot \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com"}' \
  --output page.png
```

### `GET /healthz`

Liveness check (never requires auth).

## How it works

- The image installs `agent-browser` globally and Debian's `chromium` package, wired together with `AGENT_BROWSER_EXECUTABLE_PATH`. (Not `agent-browser install`: Chrome for Testing has no Linux ARM64 builds, so that path breaks local builds on Apple Silicon.)
- agent-browser's Rust daemon starts on the first command and keeps the browser alive between commands, so chained commands within a request are fast.
- Chromium runs with `--no-sandbox` (the container runs as root, where the sandbox can't start) and `--disable-dev-shm-usage` via `AGENT_BROWSER_ARGS`.
- The server listens on `$PORT` (Vercel defaults it to 80) and handles `SIGTERM` for clean scale-in.

## Concurrency

Concurrent requests are safe. Vercel's Fluid compute routes multiple in-flight requests to the same instance, so every request runs in an isolated agent-browser session (`--session req-<uuid>`) — parallel batches each get their own browser state and can't clobber each other. Ephemeral sessions are closed when the request finishes; `tini` runs as PID 1 to reap the Chromium processes they leave behind.

To keep state across requests (at your own risk — see the caveat below), pass a session name and close it yourself when done:

```bash
curl -X POST .../run -d '{"session": "sandbox-42", "commands": [["open", "https://my-preview.vercel.app"]]}'
curl -X POST .../run -d '{"session": "sandbox-42", "commands": [["snapshot", "-i"]]}'
curl -X POST .../commands/close -d '{"session": "sandbox-42"}'
```

`/commands/<name>` also accepts `"session"`; without it, single commands share the daemon's `default` session.

Each concurrent session launches its own browser, so memory is the scaling limit per instance — beyond that, Vercel scales instances out horizontally.

## Statelessness caveat

Vercel containers autoscale and scale to zero after 5 minutes without traffic (30 seconds on preview deployments), and consecutive requests are not guaranteed to hit the same instance. A warm instance *does* keep the daemon and open pages alive, so quick successive calls often share state — but don't rely on it. Put everything a task needs into a single `/run` batch.

## Local development

```bash
# With the Vercel CLI (requires Docker):
vercel dev

# Or plain Docker:
docker build -f Dockerfile.vercel -t mini-remote-browser .
docker run --rm -p 8080:8080 -e PORT=8080 mini-remote-browser
curl -X POST localhost:8080/snapshot -H 'content-type: application/json' -d '{"url":"https://example.com"}'
```
