/**
 * Host route test for `dsh-credential-vault`. Run from the package directory:
 *
 *   node test/rpc-test.mjs
 *
 * Drives the real `/credential-vault` handler with fake Node request/response
 * objects: the admission fence, endpoint routing and the proxy `test` endpoint
 * are exercised without a browser, a socket or a running Host.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { registerRpc, RPC_CHANNEL } from '../src/rpc.js'
import { Vault } from '../src/vault.js'

class MockCredentials {
  constructor() {
    this.records = new Map()
  }
  async listRecords() {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }
  async readRecord(key) {
    return this.records.get(key)
  }
  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(key))
    if (next === undefined) return this.records.get(key)
    this.records.set(key, next)
    return next
  }
  async deleteRecord(key) {
    this.records.delete(key)
  }
}

const settings = {
  allowAgentReveal: true,
  allowAgentWrite: true,
  proxyTimeoutMs: 5000,
  proxyTestUrl: 'https://api.ipify.org?format=json',
}
const vault = new Vault({ credentials: new MockCredentials() }, settings)

let handler = null
let admission = {}
const web = {
  connection: {
    admit: () => admission,
  },
  logger: { warn() {} },
  effect: (factory) => factory(),
  webServer: {
    register: (route) => {
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, RPC_CHANNEL)
      handler = route.handler
    },
  },
  on: () => {},
}

registerRpc(web, vault, settings)
assert.equal(typeof handler, 'function', 'route registered')

function makeRequest({ path, method = 'POST', body }) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.url = path
  stream.method = method
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

function makeResponse() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headers = headers ?? {}
    return res
  }
  res.body = ''
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += chunk
    res.done = true
  }
  return res
}

async function call(endpoint, body = {}) {
  const req = makeRequest({ path: `${RPC_CHANNEL}/${endpoint}`, body })
  const res = makeResponse()
  await handler(req, res)
  let payload
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = res.body
  }
  return { status: res.statusCode, payload }
}

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('ok  ', name)
}

await check('未认证请求返回 401', async () => {
  admission = { rejection: 401 }
  const { status } = await call('status')
  assert.equal(status, 401)
})

await check('非 POST 或未知接口被拒绝', async () => {
  admission = {}
  const badMethod = makeRequest({ path: `${RPC_CHANNEL}/status`, method: 'GET' })
  const res = makeResponse()
  await handler(badMethod, res)
  assert.equal(res.statusCode, 405)

  const { status, payload } = await call('nope')
  assert.equal(status, 404)
  assert.equal(payload.ok, false)
})

await check('status 暴露代理配置与协议列表', async () => {
  admission = {}
  const { payload } = await call('status')
  assert.equal(payload.ok, true)
  assert.equal(payload.value.version, 2)
  assert.ok(payload.value.proxyProtocols.includes('socks5h'))
  assert.equal(payload.value.proxyTestUrl, settings.proxyTestUrl)
})

await check('save 拒绝非法代理字段并返回结构化错误', async () => {
  const { payload } = await call('save', { type: 'proxy', name: 'x', host: 'h', protocol: 'ftp' })
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'invalid')
})

let proxyId = null

await check('save 创建代理并在 list 中只返回元数据', async () => {
  const saved = await call('save', {
    type: 'proxy',
    name: '测试代理',
    host: '127.0.0.1',
    port: 7890,
    protocol: 'http',
    username: 'u',
    password: 'p',
  })
  assert.equal(saved.payload.ok, true)
  proxyId = saved.payload.value.entry.id
  assert.equal(saved.payload.value.entry.url, 'http://127.0.0.1:7890')

  const listed = await call('list')
  const entry = listed.payload.value.entries.find((item) => item.id === proxyId)
  assert.equal('password' in entry, false)
  assert.equal(entry.hasPassword, true)
})

await check('test 对非代理凭据返回错误而不是 500', async () => {
  const ssh = await vault.save({ type: 'ssh', name: 's', host: 'h', username: 'root', password: 'pw' })
  const { payload, status } = await call('test', { id: ssh.id })
  assert.equal(status, 200)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'invalid')
})

await check('test 对不可达代理返回 ok=false 与原因', async () => {
  const { payload } = await call('test', { id: proxyId, url: 'http://127.0.0.1:9/', timeoutMs: 1500 })
  assert.equal(payload.ok, true)
  assert.equal(payload.value.ok, false)
  assert.equal(payload.value.protocol, 'http')
  assert.ok(payload.value.error.length > 0)
})

await check('reveal 只按字段返回代理密码', async () => {
  const { payload } = await call('reveal', { id: proxyId, field: 'password' })
  assert.equal(payload.ok, true)
  assert.equal(payload.value.value, 'p')
})

await check('remove 删除后读不到', async () => {
  const { payload } = await call('remove', { id: proxyId })
  assert.equal(payload.ok, true)
  const listed = await call('list')
  assert.equal(listed.payload.value.entries.some((item) => item.id === proxyId), false)
})

console.log(`\nALL PASS (${passed} route checks)`)
