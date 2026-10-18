/**
 * Explore the DSH experimental inspector target: list CDP domains, targets and
 * execution contexts, and dump any events for a short window.
 *
 * Usage: node tools/cdp-explore.mjs <wsEndpoint> [seconds]
 */
const endpoint = process.argv[2]
const seconds = Number(process.argv[3] || 2)

const socket = new WebSocket(endpoint)
let id = 0
const pending = new Map()
const events = []

function call(method, params = {}) {
  const requestId = ++id
  return new Promise((resolve) => {
    pending.set(requestId, { resolve })
    socket.send(JSON.stringify({ id: requestId, method, params }))
    setTimeout(() => {
      if (pending.has(requestId)) { pending.delete(requestId); resolve({ __timeout: true, method }) }
    }, 5000)
  })
}

socket.addEventListener('message', (event) => {
  let message
  try { message = JSON.parse(event.data) } catch { return }
  if (message.id && pending.has(message.id)) {
    const { resolve } = pending.get(message.id)
    pending.delete(message.id)
    resolve(message)
    return
  }
  if (message.method) events.push(message)
})

socket.addEventListener('error', (event) => {
  console.error('socket error', event.message || event.type)
  process.exit(2)
})

socket.addEventListener('open', async () => {
  const results = {}
  results.schema = await call('Schema.getDomains')
  results.targets = await call('Target.getTargets')
  results.discover = await call('Target.setDiscoverTargets', { discover: true })
  results.runtime = await call('Runtime.enable')
  results.page = await call('Page.enable')
  results.frames = await call('Page.getFrameTree')
  results.console = await call('Console.enable')
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  console.log(JSON.stringify({ results, events }, null, 2).slice(0, 20000))
  socket.close()
})
