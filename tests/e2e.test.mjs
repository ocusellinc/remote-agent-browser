// End-to-end suite covering every supported agent-browser command through
// the HTTP API, using the built-in node:test runner.
//
//   npm test                                  # boots a local Docker container
//   BASE_URL=https://<deployment> npm test    # tests a deployment
//
// Env: AUTH_TOKEN (service bearer token, if the deployment sets one) and/or
// VERCEL_TRUSTED_OIDC_TOKEN (for deployments behind Deployment Protection
// with Trusted Sources: an OIDC token from a trusted issuer, e.g. GitHub
// Actions' id-token).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const TOKEN = process.env.AUTH_TOKEN
const OIDC = process.env.VERCEL_TRUSTED_OIDC_TOKEN
const MANAGED = !process.env.BASE_URL
const CONTAINER = 'remote-agent-browser-e2e'
// Host port == container port, so the in-container browser can reach
// BASE (used as a real http origin) at the same address the tests use.
const LOCAL_PORT = 18080

let BASE = process.env.BASE_URL

before(async () => {
  if (MANAGED) {
    console.log('BASE_URL not set — building and starting a local container')
    execFileSync('docker', ['build', '-f', 'Dockerfile.vercel', '-t', 'remote-agent-browser', '.'], { stdio: 'inherit' })
    try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch {}
    execFileSync('docker', [
      'run', '-d', '--rm', '--name', CONTAINER,
      '-p', `127.0.0.1:${LOCAL_PORT}:${LOCAL_PORT}`, '-e', `PORT=${LOCAL_PORT}`,
      'remote-agent-browser',
    ])
    BASE = `http://127.0.0.1:${LOCAL_PORT}`
  }
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`service at ${BASE} did not become healthy`)
})

after(() => {
  if (MANAGED) try { execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' }) } catch {}
})

// --- helpers ---------------------------------------------------------------

const headers = () => ({
  'content-type': 'application/json',
  ...(TOKEN && { authorization: `Bearer ${TOKEN}` }),
  ...(OIDC && { 'x-vercel-trusted-oidc-idp-token': OIDC }),
})

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  const type = res.headers.get('content-type') ?? ''
  const data = type.includes('application/json')
    ? await res.json()
    : Buffer.from(await res.arrayBuffer())
  return { status: res.status, type, data }
}

async function run(commands, opts = {}) {
  const { status, data } = await post('/run', { commands, stopOnError: false, ...opts })
  assert.ok(status === 200 || status === 422, `unexpected http ${status}: ${JSON.stringify(data).slice(0, 200)}`)
  const results = data.results ?? []
  return { status, results, out: results.map((r) => r.stdout.trim()) }
}

const covered = new Set()

// One spec per command scenario. `cmds` may be a function (lazy, for BASE).
// `verify(out, results)` asserts behavior; omit for exit-0-only checks.
// `accepted: true` = only assert the server accepted the command — used where
// success depends on the environment, with the reason in the name.
// agent-browser commands that trigger a navigation (back, click on a link)
// can race the page teardown they cause; over slow links this surfaces as a
// transient CDP error. Batches are self-contained, so retry the whole batch
// once.
const TRANSIENT = /Inspected target navigated or closed|Execution context was destroyed/

function defineCases(cases) {
  for (const spec of cases) {
    it(spec.name, async () => {
      const commands = typeof spec.cmds === 'function' ? spec.cmds() : spec.cmds
      for (const cmd of commands) covered.add(cmd.find((a) => !a.startsWith('-')))
      let { results, out } = await run(commands)
      const transient = (r) => !r.ok && TRANSIENT.test(r.stderr || r.stdout)
      if (!spec.accepted && results.some(transient)) {
        ;({ results, out } = await run(commands))
      }
      if (!spec.accepted) {
        for (const r of results) assert.ok(r.ok, `${r.command} failed: ${(r.stderr || r.stdout).slice(0, 200)}`)
      }
      spec.verify?.(out, results)
    })
  }
}

// --- fixtures --------------------------------------------------------------

const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html><head><title>TestPage</title></head><body>
<h1 id="h">Hello</h1>
<input id="text">
<input id="cb" type="checkbox">
<select id="sel"><option value="a">A</option><option value="b">B</option></select>
<button id="btn" onclick="document.title='clicked'">Btn</button>
<button id="dbl" ondblclick="document.title='dblclicked'">Dbl</button>
<div id="hov" onmouseover="this.textContent='hovered'">hover me</div>
<input id="file" type="file">
<a id="dl" href="https://example.com/" title="dlink">dl</a>
<div style="height:3000px"></div>
<div id="bottom">bottom</div>
</body></html>`)}`

// data: pages are opaque origins, so thrown messages are muted — tests assert
// an error entry exists, not its text.
const ERROR_PAGE = `data:text/html,${encodeURIComponent(
  '<script>setTimeout(function(){throw new Error("boom")},0)</script><p>err page</p>'
)}`

const httpPage = () => `${BASE}/healthz`

// --- specs -----------------------------------------------------------------

describe('server endpoints', () => {
  it('GET /healthz', async () => {
    const res = await fetch(`${BASE}/healthz`)
    assert.equal(res.status, 200)
  })
  it('GET /commands lists the surface', async () => {
    const res = await fetch(`${BASE}/commands`, { headers: headers() })
    assert.equal(res.status, 200)
    const { commands } = await res.json()
    assert.ok(Object.keys(commands).length > 40)
  })
  it('rejects unknown commands', async () => {
    const { status } = await post('/run', { commands: [['frobnicate']] })
    assert.equal(status, 400)
  })
  it('rejects malformed bodies', async () => {
    const { status } = await post('/run', { commands: 'nope' })
    assert.equal(status, 400)
  })
})

describe('core interaction', () => {
  defineCases([
    {
      name: 'open, get title/url',
      cmds: [['open', PAGE], ['get', 'title'], ['get', 'url']],
      verify: (out) => {
        assert.equal(out[1], 'TestPage')
        assert.match(out[2], /^data:/)
      },
    },
    {
      name: 'read returns page text',
      cmds: [['open', PAGE], ['read']],
      verify: (out) => assert.match(out[1], /Hello/),
    },
    {
      name: 'snapshot -i returns refs',
      cmds: [['open', PAGE], ['snapshot', '-i']],
      verify: (out) => assert.match(out[1], /ref=e\d/),
    },
    {
      name: 'click triggers handlers',
      cmds: [['open', PAGE], ['click', '#btn'], ['get', 'title']],
      verify: (out) => assert.equal(out[2], 'clicked'),
    },
    {
      name: 'dblclick triggers handlers',
      cmds: [['open', PAGE], ['dblclick', '#dbl'], ['get', 'title']],
      verify: (out) => assert.equal(out[2], 'dblclicked'),
    },
    {
      name: 'fill sets value',
      cmds: [['open', PAGE], ['fill', '#text', 'abc'], ['get', 'value', '#text']],
      verify: (out) => assert.equal(out[2], 'abc'),
    },
    {
      name: 'type appends without clearing',
      cmds: [['open', PAGE], ['fill', '#text', 'ab'], ['type', '#text', 'cd'], ['get', 'value', '#text']],
      verify: (out) => assert.equal(out[3], 'abcd'),
    },
    {
      name: 'press sends a key',
      cmds: [['open', PAGE], ['focus', '#text'], ['press', 'z'], ['get', 'value', '#text']],
      verify: (out) => assert.equal(out[3], 'z'),
    },
    {
      name: 'keyboard types without selector',
      cmds: [['open', PAGE], ['focus', '#text'], ['keyboard', 'type', 'hi'], ['get', 'value', '#text']],
      verify: (out) => assert.equal(out[3], 'hi'),
    },
    {
      name: 'hover triggers handlers',
      cmds: [['open', PAGE], ['hover', '#hov'], ['get', 'text', '#hov']],
      verify: (out) => assert.equal(out[2], 'hovered'),
    },
    {
      // eval JSON-encodes string results, hence the quoted expectation
      name: 'focus + eval activeElement',
      cmds: [['open', PAGE], ['focus', '#text'], ['eval', 'document.activeElement.id']],
      verify: (out) => assert.equal(out[2], '"text"'),
    },
    {
      name: 'check / uncheck / is checked',
      cmds: [['open', PAGE], ['check', '#cb'], ['is', 'checked', '#cb'], ['uncheck', '#cb'], ['is', 'checked', '#cb']],
      verify: (out) => {
        assert.equal(out[2], 'true')
        assert.equal(out[4], 'false')
      },
    },
    {
      name: 'select picks an option',
      cmds: [['open', PAGE], ['select', '#sel', 'b'], ['get', 'value', '#sel']],
      verify: (out) => assert.equal(out[2], 'b'),
    },
    {
      name: 'find by text and click',
      cmds: [['open', PAGE], ['find', 'text', 'Btn', 'click'], ['get', 'title']],
      verify: (out) => assert.equal(out[2], 'clicked'),
    },
    {
      name: 'is visible / enabled',
      cmds: [['open', PAGE], ['is', 'visible', '#h'], ['is', 'enabled', '#btn']],
      verify: (out) => {
        assert.equal(out[1], 'true')
        assert.equal(out[2], 'true')
      },
    },
    {
      name: 'get text/html/count/box/styles/attr',
      cmds: [
        ['open', PAGE], ['get', 'text', '#h'], ['get', 'html', '#h'], ['get', 'count', 'input'],
        ['get', 'box', '#h'], ['get', 'styles', '#h'], ['get', 'attr', '#dl', 'title'],
      ],
      verify: (out) => {
        assert.equal(out[1], 'Hello')
        assert.match(out[2], /Hello/)
        assert.equal(out[3], '3')
        assert.ok(out[4].length > 0)
        assert.ok(out[5].length > 0)
        assert.equal(out[6], 'dlink')
      },
    },
    {
      name: 'eval computes',
      cmds: [['eval', '6*7']],
      verify: (out) => assert.equal(out[0], '42'),
    },
    {
      name: 'scroll + scrollintoview move the viewport',
      cmds: [
        ['open', PAGE], ['scroll', 'down', '500'], ['eval', 'window.scrollY'],
        ['scrollintoview', '#bottom'], ['eval', 'window.scrollY > 1000'],
      ],
      verify: (out) => {
        assert.ok(Number(out[2]) >= 400)
        assert.equal(out[4], 'true')
      },
    },
    { name: 'mouse move/wheel', cmds: [['open', PAGE], ['mouse', 'move', '50', '50'], ['mouse', 'wheel', '200']] },
    { name: 'wait for ms and selector', cmds: [['open', PAGE], ['wait', '100'], ['wait', '#h']] },
    { name: 'highlight', cmds: [['open', PAGE], ['highlight', '#h']] },
    { name: 'upload a file from inside the container', cmds: [['open', PAGE], ['upload', '#file', '/etc/hostname']] },
    { name: 'drag (accepted; no droppable targets on page)', cmds: [['open', PAGE], ['drag', '#h', '#bottom']], accepted: true },
    { name: 'download (accepted; plain link)', cmds: [['open', PAGE], ['download', '#dl', '/tmp/dl.out']], accepted: true },
  ])
})

describe('emulation', () => {
  defineCases([
    {
      name: 'set viewport',
      cmds: [['open', PAGE], ['set', 'viewport', '500', '600'], ['eval', 'innerWidth']],
      verify: (out) => assert.equal(out[2], '500'),
    },
    {
      name: 'set media dark',
      cmds: [['open', PAGE], ['set', 'media', 'dark'], ['eval', 'matchMedia("(prefers-color-scheme: dark)").matches']],
      verify: (out) => assert.equal(out[2], 'true'),
    },
  ])
})

describe('http-origin state', () => {
  defineCases([
    {
      name: 'cookies set/get/clear',
      cmds: () => [[  'open', httpPage()], ['cookies', 'set', 'k', 'v'], ['cookies', 'get'], ['cookies', 'clear']],
      verify: (out) => assert.match(out[2], /k/),
    },
    {
      name: 'storage local set/get',
      cmds: () => [['open', httpPage()], ['storage', 'local', 'set', 'foo', 'bar'], ['storage', 'local', 'get', 'foo']],
      verify: (out) => assert.match(out[2], /bar/),
    },
    {
      name: 'back / forward / reload',
      cmds: () => [
        ['open', httpPage()], ['open', PAGE], ['wait', '250'],
        ['back'], ['wait', '250'], ['get', 'url'],
        ['forward'], ['wait', '250'], ['get', 'title'], ['reload'],
      ],
      verify: (out) => {
        assert.match(out[5], /healthz/)
        assert.equal(out[8], 'TestPage')
      },
    },
    {
      name: 'pushstate rewrites the URL',
      cmds: () => [['open', httpPage()], ['pushstate', '/virtual'], ['get', 'url']],
      verify: (out) => assert.match(out[2], /\/virtual$/),
    },
    {
      name: 'network requests are logged',
      cmds: () => [['open', httpPage()], ['network', 'requests']],
      verify: (out) => assert.match(out[1], /healthz/),
    },
    {
      name: 'console captures logs',
      cmds: () => [['open', httpPage()], ['eval', 'console.log("marker-123")'], ['wait', '200'], ['console']],
      verify: (out) => assert.match(out[3], /marker-123/),
    },
    {
      name: 'errors captures page errors',
      cmds: [['open', ERROR_PAGE], ['wait', '400'], ['errors']],
      verify: (out) => assert.match(out[2], /✗/),
    },
    {
      name: 'tab new/list/close',
      cmds: () => [['open', httpPage()], ['tab', 'new'], ['tab', 'list'], ['tab', 'close']],
      verify: (out) => assert.ok((out[2].match(/\[t\d/g) ?? []).length >= 2),
    },
    { name: 'vitals', cmds: () => [['open', httpPage()], ['vitals']] },
    { name: 'state save/load', cmds: () => [['open', httpPage()], ['state', 'save', '/tmp/state.json'], ['state', 'load', '/tmp/state.json']] },
    { name: 'diff snapshot', cmds: [['open', PAGE], ['snapshot'], ['click', '#btn'], ['diff', 'snapshot']] },
    { name: 'batch runs sub-commands', cmds: [['batch', 'get title', 'get url']] },
  ])
})

describe('debug & tooling', () => {
  defineCases([
    { name: 'trace start/stop', cmds: () => [['open', httpPage()], ['trace', 'start'], ['reload'], ['trace', 'stop', '/tmp/trace.json']] },
    { name: 'profiler start/stop', cmds: () => [['open', httpPage()], ['profiler', 'start'], ['reload'], ['profiler', 'stop', '/tmp/profile.json']] },
    { name: 'record (accepted; image ships without ffmpeg)', cmds: () => [['open', httpPage()], ['record', 'start', '/tmp/rec.webm'], ['record', 'stop']], accepted: true },
    { name: 'session', cmds: [['session']] },
    { name: 'skills list', cmds: [['skills']] },
    { name: 'doctor (accepted; environment-dependent)', cmds: [['doctor']], accepted: true },
    { name: 'clipboard (accepted; headless permissions vary)', cmds: [['open', PAGE], ['clipboard', 'write', 'hello'], ['clipboard', 'read']], accepted: true },
    { name: 'react (accepted; needs a React app + react-devtools)', cmds: () => [['open', httpPage()], ['react', 'tree']], accepted: true },
    { name: 'removeinitscript (accepted; none registered)', cmds: [['removeinitscript', '1']], accepted: true },
    { name: 'close', cmds: [['close']] },
  ])
})

describe('binary outputs', () => {
  const magic = async (command, body, expected, expectedType) => {
    covered.add(command)
    const { status, type, data } = await post(`/commands/${command}`, body)
    assert.equal(status, 200)
    assert.match(type, expectedType)
    assert.ok(Buffer.isBuffer(data), 'expected raw bytes')
    assert.equal(data.subarray(0, expected.length).toString('latin1'), expected)
  }
  it('screenshot returns PNG bytes', () => magic('screenshot', {}, '\x89PNG', /image\/png/))
  it('screenshot honors jpeg format flag', () =>
    magic('screenshot', { flags: { screenshotFormat: 'jpeg' } }, '\xff\xd8\xff', /image\/jpeg/))
  it('pdf returns PDF bytes', () => magic('pdf', {}, '%PDF', /application\/pdf/))
})

describe('sessions', () => {
  it('named session persists across requests', async () => {
    const session = `e2e-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    await run([['open', PAGE]], { session })
    const { out } = await run([['get', 'title']], { session })
    assert.equal(out[0], 'TestPage')
    await post('/commands/close', { session })
  })
  it('parallel requests are isolated', async () => {
    const [a, b] = await Promise.all([
      run([['open', PAGE], ['get', 'title']]),
      run([['open', httpPage()], ['get', 'url']]),
    ])
    assert.equal(a.out[1], 'TestPage')
    assert.match(b.out[1], /healthz/)
  })
})

describe('coverage', () => {
  it('every advertised command is exercised', async () => {
    const res = await fetch(`${BASE}/commands`, { headers: headers() })
    const { commands } = await res.json()
    const missing = Object.keys(commands).filter((name) => !covered.has(name))
    assert.deepEqual(missing, [])
  })
})
