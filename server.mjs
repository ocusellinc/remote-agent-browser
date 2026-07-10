import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT) || 80
// Snapshots of large pages can be big
const MAX_BUFFER = 32 * 1024 * 1024
const MAX_BODY = 1 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 60_000

// Full page-facing agent-browser command surface. Excluded on purpose:
// install/upgrade/doctor --fix (image is immutable), dashboard/mcp/chat/
// inspect (interactive), connect/stream (ports other than $PORT are not
// routable), plugin/profiles/auth/confirm/deny (host-level state).
const COMMANDS = {
  // Core
  open: 'Navigate to URL',
  read: 'Fetch agent-readable text of a page',
  click: 'Click element (selector or @ref)',
  dblclick: 'Double-click element',
  type: 'Type into element without clearing',
  fill: 'Clear and fill element',
  press: 'Press key (Enter, Tab, Control+a)',
  keyboard: 'Raw keyboard input: type <text> | inserttext <text>',
  hover: 'Hover element',
  focus: 'Focus element',
  check: 'Check checkbox',
  uncheck: 'Uncheck checkbox',
  select: 'Select dropdown option(s)',
  drag: 'Drag and drop <src> <dst>',
  upload: 'Upload files to <sel> (paths inside the container)',
  download: 'Download file by clicking element',
  scroll: 'Scroll up/down/left/right [px]',
  scrollintoview: 'Scroll element into view',
  wait: 'Wait for selector or milliseconds',
  screenshot: 'Take screenshot (returns image unless a path arg is given)',
  pdf: 'Save page as PDF (returns the PDF)',
  snapshot: 'Accessibility tree with refs (-i interactive, -c compact)',
  eval: 'Run JavaScript in the page',
  close: 'Close browser (--all closes every session)',
  // Navigation
  back: 'Go back',
  forward: 'Go forward',
  reload: 'Reload page',
  pushstate: 'SPA client-side navigation',
  // Info & state
  get: 'get <text|html|value|attr|title|url|count|box|styles> [sel]',
  is: 'is <visible|enabled|checked> <sel>',
  find: 'find <role|text|label|placeholder|...> <value> <action>',
  // Input devices
  mouse: 'mouse <move|down|up|wheel> [args]',
  // Browser settings
  set: 'set <viewport|device|geo|offline|headers|credentials|media> ...',
  // Network & storage
  network: 'network <route|unroute|requests|har> ...',
  cookies: 'cookies [get|set|clear]',
  storage: 'storage <local|session> ...',
  state: 'state <save|load> for auth state JSON',
  // Tabs
  tab: 'tab [new|list|close|<n>]',
  // Diffing & debugging
  diff: 'diff <snapshot|screenshot|url> ...',
  trace: 'trace <start|stop> (stop returns the trace file)',
  profiler: 'profiler <start|stop> (stop returns the profile)',
  record: 'record <start|stop> video (stop returns the WebM)',
  console: 'View console logs (--clear to reset)',
  errors: 'View page errors (--clear to reset)',
  highlight: 'Highlight element',
  clipboard: 'clipboard <read|write|copy|paste> [text]',
  // React & performance
  react: 'react <tree|inspect|renders|suspense> (open with --enable react-devtools)',
  vitals: 'Core Web Vitals (LCP/CLS/TTFB/FCP/INP)',
  // Misc
  removeinitscript: 'Remove a registered init script',
  batch: 'Execute multiple commands sequentially',
  session: 'Show or list sessions',
  skills: 'List or fetch agent-browser usage skills',
  doctor: 'Diagnose the environment',
}

// Commands whose subcommand writes a file we should send back. When the
// caller omits a path, we inject a /tmp path and respond with the bytes.
const FILE_OUTPUT = {
  screenshot: { subcommand: null, ext: 'png', type: 'image/png' },
  pdf: { subcommand: null, ext: 'pdf', type: 'application/pdf' },
  trace: { subcommand: 'stop', ext: 'json', type: 'application/json' },
  profiler: { subcommand: 'stop', ext: 'json', type: 'application/json' },
  record: { subcommand: 'stop', ext: 'webm', type: 'video/webm' },
}

function runAgentBrowser(args) {
  return new Promise((resolve) => {
    execFile(
      'agent-browser',
      args,
      { maxBuffer: MAX_BUFFER, timeout: COMMAND_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolve({
          command: ['agent-browser', ...args].join(' '),
          ok: !error,
          exitCode: error ? (error.code ?? 1) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        })
      }
    )
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function authorized(req) {
  const token = process.env.AUTH_TOKEN
  if (!token) return true
  return req.headers.authorization === `Bearer ${token}`
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

// { json: true, fullPage: true, depth: 2, enable: ["react-devtools"] }
// → ["--json", "--full-page", "--depth", "2", "--enable", "react-devtools"]
function flagsToArgs(flags) {
  const args = []
  for (const [key, value] of Object.entries(flags)) {
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      args.push(flag)
      if (item !== true) args.push(String(item))
    }
  }
  return args
}

function firstCommandToken(args) {
  return args.find((arg) => !arg.startsWith('-'))
}

// Concurrent requests can share one instance (Fluid compute), so each request
// runs in an isolated agent-browser session instead of the shared default.
// Callers may pass a session name to reuse state across commands; unnamed
// sessions are ephemeral and closed when the request finishes.
function resolveSession(body) {
  const explicit = typeof body.session === 'string' ? body.session : null
  if (explicit && !/^[\w.-]{1,64}$/.test(explicit)) {
    return { error: '"session" must match [A-Za-z0-9_.-]{1,64}' }
  }
  return {
    session: explicit ?? `req-${randomUUID()}`,
    ephemeral: !explicit,
  }
}

function withSession(session, args) {
  return ['--session', session, ...args]
}

async function closeSession(session) {
  // Best-effort: the batch may already have closed it
  await runAgentBrowser(withSession(session, ['close']))
}

function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return 'Body must include "commands": a non-empty array of arg arrays, e.g. [["open", "https://example.com"], ["snapshot", "-i", "--json"]]'
  }
  for (const command of commands) {
    if (!isStringArray(command) || command.length === 0) {
      return 'Each command must be a non-empty array of strings'
    }
    const name = firstCommandToken(command)
    if (!name || !COMMANDS[name]) {
      return `Unknown or unsupported command "${name ?? command[0]}". See GET /commands`
    }
  }
  return null
}

async function sendFileResult(res, results, path, type) {
  try {
    const data = await readFile(path)
    res.writeHead(200, { 'content-type': type, 'content-length': data.length })
    res.end(data)
  } catch {
    sendJson(res, 500, { error: `Command succeeded but no output file was produced at ${path}`, results })
  } finally {
    unlink(path).catch(() => {})
  }
}

// POST /commands/<name>  { args: [...], flags: {...} }
async function handleCommand(name, body, res) {
  if (!COMMANDS[name]) {
    return sendJson(res, 404, { error: `Unknown command "${name}". See GET /commands` })
  }
  const args = body.args ?? []
  if (!isStringArray(args)) {
    return sendJson(res, 400, { error: '"args" must be an array of strings' })
  }
  if (body.flags !== undefined && (typeof body.flags !== 'object' || Array.isArray(body.flags) || body.flags === null)) {
    return sendJson(res, 400, { error: '"flags" must be an object' })
  }
  const flagArgs = body.flags ? flagsToArgs(body.flags) : []
  // Single commands are only useful across requests with caller-managed
  // sessions, so default to the shared "default" session (no flag) unless
  // the caller names one.
  const sessionArgs =
    typeof body.session === 'string' ? withSession(body.session, []) : []
  if (sessionArgs.length && !/^[\w.-]{1,64}$/.test(body.session)) {
    return sendJson(res, 400, { error: '"session" must match [A-Za-z0-9_.-]{1,64}' })
  }

  // File-producing commands: inject a /tmp path and return the bytes,
  // unless the caller already supplied a path argument themselves.
  const fileSpec = FILE_OUTPUT[name]
  const positionals = args.filter((arg) => !arg.startsWith('-'))
  const wantsFile =
    fileSpec &&
    (fileSpec.subcommand === null
      ? positionals.length === 0
      : positionals.length === 1 && positionals[0] === fileSpec.subcommand)
  if (wantsFile) {
    const path = `/tmp/output-${randomUUID()}.${fileSpec.ext}`
    const format = body.flags?.screenshotFormat
    const finalPath = name === 'screenshot' && format === 'jpeg' ? path.replace(/png$/, 'jpg') : path
    const result = await runAgentBrowser([...sessionArgs, name, ...args, finalPath, ...flagArgs])
    if (!result.ok) return sendJson(res, 422, { results: [result] })
    const type = name === 'screenshot' && format === 'jpeg' ? 'image/jpeg' : fileSpec.type
    return sendFileResult(res, [result], finalPath, type)
  }

  const result = await runAgentBrowser([...sessionArgs, name, ...args, ...flagArgs])
  sendJson(res, result.ok ? 200 : 422, { results: [result] })
}

// Instances scale to zero and requests are not pinned to an instance, so a
// browser session is only guaranteed to exist within a single request. Batch
// everything a task needs into one /run call.
async function handleRun(body, res) {
  const error = validateCommands(body.commands)
  if (error) return sendJson(res, 400, { error })
  const resolved = resolveSession(body)
  if (resolved.error) return sendJson(res, 400, { error: resolved.error })
  const { session, ephemeral } = resolved

  const results = []
  try {
    for (const command of body.commands) {
      const result = await runAgentBrowser(withSession(session, command))
      results.push(result)
      if (!result.ok && body.stopOnError !== false) break
    }
  } finally {
    if (ephemeral) await closeSession(session)
  }
  sendJson(res, results.every((r) => r.ok) ? 200 : 422, { results, session })
}

async function handleSnapshot(body, res) {
  if (typeof body.url !== 'string') {
    return sendJson(res, 400, { error: 'Body must include "url"' })
  }
  const session = `req-${randomUUID()}`
  try {
    const open = await runAgentBrowser(withSession(session, ['open', body.url]))
    if (!open.ok) return sendJson(res, 422, { results: [open] })
    const snapshot = await runAgentBrowser(withSession(session, ['snapshot', '-i', '--json']))
    if (!snapshot.ok) return sendJson(res, 422, { results: [open, snapshot] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(snapshot.stdout)
  } finally {
    await closeSession(session)
  }
}

async function handleScreenshot(body, res) {
  if (typeof body.url !== 'string') {
    return sendJson(res, 400, { error: 'Body must include "url"' })
  }
  const session = `req-${randomUUID()}`
  try {
    const open = await runAgentBrowser(withSession(session, ['open', body.url]))
    if (!open.ok) return sendJson(res, 422, { results: [open] })
    const path = `/tmp/screenshot-${randomUUID()}.png`
    const args = ['screenshot', path]
    if (body.fullPage) args.push('--full')
    const shot = await runAgentBrowser(withSession(session, args))
    if (!shot.ok) return sendJson(res, 422, { results: [open, shot] })
    return await sendFileResult(res, [open, shot], path, 'image/png')
  } finally {
    await closeSession(session)
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      return sendJson(res, 200, { ok: true })
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }
    if (req.method === 'GET' && req.url === '/commands') {
      return sendJson(res, 200, { commands: COMMANDS })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' })
    }

    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message })
    }

    const commandMatch = req.url.match(/^\/commands\/([a-z]+)$/)
    if (commandMatch) {
      return await handleCommand(commandMatch[1], body, res)
    }
    switch (req.url) {
      case '/run':
        return await handleRun(body, res)
      case '/snapshot':
        return await handleSnapshot(body, res)
      case '/screenshot':
        return await handleScreenshot(body, res)
      default:
        return sendJson(res, 404, { error: 'Not found' })
    }
  } catch (error) {
    console.error(error)
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' })
    } else {
      res.end()
    }
  }
})

server.listen(PORT, () => {
  console.log(`remote-agent-browser listening on :${PORT}`)
})

// Vercel sends SIGTERM with a 30s grace period on scale-in
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
