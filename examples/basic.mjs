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
