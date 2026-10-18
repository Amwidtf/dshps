/**
 * Minimal CDP probe against the DSH experimental inspector target.
 * Run: node tools/cdp-probe.mjs <wsEndpoint> [expression]
 * Prints JSON result of Runtime.evaluate.
 */
const endpoint = process.argv[2]
const expression = process.argv[3] || '1+1'

const socket = new WebSocket(endpoint)
let id = 0
const pending = new Map()

function call(method, params = {}) {
  const requestId = ++id
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    socket.send(JSON.stringify({ id: requestId, method, params }))
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, 10000)
  })
}

socket.addEventListener('message', (event) => {
  let message
  try {
    message = JSON.parse(event.data)
  } catch {
    return
  }
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

socket.addEventListener('error', (event) => {
  console.error('socket error', event.message || event.type)
  process.exit(2)
})

socket.addEventListener('open', async () => {
  try {
    await call('Runtime.enable')
    const contexts = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    console.log(JSON.stringify(contexts, null, 2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    socket.close()
  }
})
