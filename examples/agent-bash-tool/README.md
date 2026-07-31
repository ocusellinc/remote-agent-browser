# Agent Bash tool integration

This example lets an agent use the normal `agent-browser <command>` syntax
through its Bash tool:

```bash
agent-browser open https://example.com
agent-browser snapshot -i --json
agent-browser click @e3
```

`remote-agent-browser` does not install an executable in the agent's Bash
environment. The host that implements the Bash tool intercepts these commands
and forwards them to a browser running in a dedicated Vercel Sandbox.

## Connect the adapter

[`adapter.ts`](./adapter.ts) accepts an agent session ID and a parsed argument
array. Call it before the Bash tool's regular command executor:

```ts
import { closeBrowser, runBrowserCommand } from './adapter.js'

export async function executeBashTool(
  agentSessionId: string,
  argv: string[],
) {
  const browserResult = await runBrowserCommand(agentSessionId, argv)
  if (browserResult.handled) return browserResult

  return executeRegularBash(argv)
}

export async function endAgentSession(agentSessionId: string) {
  await closeBrowser(agentSessionId)
}
```

The adapter keeps one browser client per agent session. Separate Bash calls
therefore share the same page, cookies, tabs, and element references. Closing
the agent session closes Chromium and stops its Sandbox.

Return `stdout`, `stderr`, and `exitCode` from a handled invocation as the Bash
tool result. When `file` is present, expose its bytes using the attachment or
file-result mechanism supported by the agent framework.

## Shell command strings

The example expects the Bash implementation to provide parsed arguments such
as:

```ts
['agent-browser', 'find', 'role', 'button', 'click', '--name', 'Submit']
```

If the Bash tool receives a shell command string, use a shell-aware parser.
Do not split on whitespace because that breaks quoting and escaping. After
parsing, forward a single invocation with `browser.exec()` as the adapter does,
or forward a sequence of commands together with `browser.run()`.

## Reach the application

The browser runs in a different Sandbox from the agent's Bash environment, so
that environment's `localhost` does not point to the application. Give the
agent a URL reachable from the browser Sandbox, such as a deployment or preview
URL.

## File output

For `screenshot`, `pdf`, `trace stop`, `profiler stop`, and `record stop`, omit
the output path when the file should be returned to the agent. The client
creates a temporary remote path and returns the bytes in `result.file`. If the
agent supplies an explicit output path, that path belongs to the remote browser
Sandbox and is not copied back automatically.
