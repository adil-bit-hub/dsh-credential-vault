/**
 * Self-test for the Host half. Run from the package directory:
 *
 *   node test/self-test.mjs
 *
 * It uses an in-memory credential store and never touches the real
 * `$DSH_HOME/.credentials.yaml`, SSH hosts or the network.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

import { extractExitIp } from '../src/proxy.js'
import { buildSshInvocation } from '../src/ssh.js'
import { registerTools } from '../src/tools.js'
import { Vault, VaultError, toSummary } from '../src/vault.js'

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

const ctx = { credentials: new MockCredentials(), logger: { info() {} } }
const settings = {
  promptSummary: true,
  maxPromptEntries: 12,
  allowAgentReveal: true,
  allowAgentWrite: true,
  sshTimeoutMs: 20000,
  proxyTimeoutMs: 5000,
  proxyTestUrl: 'https://api.ipify.org?format=json',
}
const vault = new Vault(ctx, settings)

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log('ok  ', name)
}
async function rejects(name, fn, code) {
  let error
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof VaultError, `${name}: expected VaultError, got ${error}`)
  assert.equal(error.code, code, `${name}: code ${error.code}`)
  passed += 1
  console.log('ok  ', name, `(${code})`)
}

// --- storage ---------------------------------------------------------------
const web = await vault.save({
  type: 'web',
  name: '公司 OA',
  note: '内网报销系统',
  url: 'oa.example.com/login',
  username: 'alice',
  password: 'p@ss word',
})
assert.match(web.id, /^web-[0-9a-f]{12}$/)
const listed = await vault.list()
assert.equal(listed.length, 1)
assert.equal(listed[0].url, 'https://oa.example.com/login')
assert.equal('password' in listed[0], false, 'summary must not carry secrets')
console.log('ok   保存网页凭据并规范化 URL')

await ok('默认掩码读取', async () => {
  assert.equal((await vault.describe(web.id)).password, '••••••••')
})
await ok('reveal 返回明文', async () => {
  assert.equal((await vault.revealEntry(web.id)).password, 'p@ss word')
})
await ok('更新时留空保持密钥', async () => {
  await vault.save({ id: web.id, name: '公司 OA（新）', password: '' })
  const entry = await vault.revealEntry(web.id)
  assert.equal(entry.name, '公司 OA（新）')
  assert.equal(entry.password, 'p@ss word')
  assert.equal(entry.url, 'https://oa.example.com/login')
})
await ok('password:null 清除密钥', async () => {
  await vault.save({ id: web.id, password: null })
  assert.equal((await vault.describe(web.id)).hasSecrets.password, false)
})

await rejects('缺少名称被拒绝', () => vault.save({ type: 'web', url: 'https://x.test', username: 'u' }), 'invalid')
await rejects('非法 URL 被拒绝', () => vault.save({ type: 'web', name: 'x', url: 'ftp://x.test', username: 'u' }), 'invalid')
await rejects('SSH 缺认证信息被拒绝', () => vault.save({ type: 'ssh', name: 's', host: 'h', username: 'root' }), 'invalid')
await rejects('SSH 端口越界被拒绝', () => vault.save({ type: 'ssh', name: 's', host: 'h', username: 'root', password: 'p', port: 99999 }), 'invalid')
await rejects('未知 id 被拒绝', () => vault.describe('web-doesnotexist'), 'not-found')

const gh = await vault.save({
  type: 'github',
  name: '个人 GitHub',
  note: '仓库管理与 PR',
  username: 'octocat',
  token: 'ghp_secret_token',
  email: 'octocat@example.com',
})
await vault.list()
const prompt = vault.promptSection()
assert.ok(prompt.includes('个人 GitHub'))
assert.ok(!prompt.includes('ghp_secret_token'), 'prompt never carries the token')
console.log('ok   提示词段只含元数据')

await ok('github 摘要不含 token', async () => {
  const summary = toSummary(await vault.readRaw(gh.id))
  assert.equal(summary.hasToken, true)
  assert.equal('token' in summary, false)
})

const sshEntry = await vault.save({
  type: 'ssh',
  name: '生产服务器',
  note: '部署与重启服务',
  host: '10.0.0.5',
  port: 2222,
  username: 'root',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
  passphrase: 'key-pass',
})
await vault.refresh()
assert.ok(vault.promptSection().includes('root@10.0.0.5:2222'))
console.log('ok   SSH 凭据与目标描述')

await ok('删除凭据', async () => {
  await vault.remove(web.id)
  const remaining = await vault.list()
  assert.deepEqual(remaining.map((entry) => entry.id).sort(), [gh.id, sshEntry.id].sort())
})

// --- tools -----------------------------------------------------------------
const tools = new Map()
registerTools({ tools: { register: (tool) => tools.set(tool.name, tool) } }, vault, settings)
assert.deepEqual([...tools.keys()].sort(), ['credential_get', 'credential_list', 'credential_save', 'proxy_test', 'ssh_exec'])
assert.equal((await tools.get('credential_list').execute({ type: 'github' })).count, 1)
assert.equal((await tools.get('credential_get').execute({ id: gh.id })).token, '••••••••')
assert.equal((await tools.get('credential_get').execute({ id: gh.id, reveal: true })).token, 'ghp_secret_token')
console.log('ok   credential_list / credential_get')

const strictTools = new Map()
registerTools({ tools: { register: (tool) => strictTools.set(tool.name, tool) } }, vault, { ...settings, allowAgentReveal: false })
await rejects('allowAgentReveal=false 拒绝明文', () => strictTools.get('credential_get').execute({ id: gh.id, reveal: true }), 'forbidden')

const readOnlyTools = new Map()
registerTools({ tools: { register: (tool) => readOnlyTools.set(tool.name, tool) } }, vault, { ...settings, allowAgentWrite: false })
await rejects('allowAgentWrite=false 拒绝写入', () => readOnlyTools.get('credential_save').execute({ type: 'web', name: 'x', url: 'https://x.test', username: 'u' }), 'forbidden')
await rejects('ssh_exec 拒绝非 SSH 凭据', () => tools.get('ssh_exec').execute({ id: gh.id, command: 'id' }), 'invalid')

// --- SSH invocation --------------------------------------------------------
const askpass = 'askpass.exe'
const keyEntry = await vault.readRaw(sshEntry.id)
const keyInvocation = await buildSshInvocation(keyEntry, 'echo hi', { askpass, sshPath: 'ssh-fake' })
assert.equal(keyInvocation.file, 'ssh-fake')
assert.equal(keyInvocation.target, 'root@10.0.0.5:2222')
assert.equal(keyInvocation.args[0], '-p')
assert.equal(keyInvocation.args[1], '2222')
assert.ok(keyInvocation.args.includes('-i'))
assert.ok(keyInvocation.args.includes('StrictHostKeyChecking=accept-new'))
assert.equal(keyInvocation.env.SSH_ASKPASS, askpass)
assert.equal(keyInvocation.env.SSH_ASKPASS_REQUIRE, 'force')
assert.equal(keyInvocation.env.DSH_VAULT_ASKPASS, 'key-pass')
assert.equal(keyInvocation.args.at(-2), 'root@10.0.0.5')
assert.equal(keyInvocation.args.at(-1), 'echo hi')
const keyPath = keyInvocation.args[keyInvocation.args.indexOf('-i') + 1]
assert.equal(readFileSync(keyPath, 'utf8'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
rmSync(keyInvocation.keyDir, { recursive: true, force: true })
assert.ok(!existsSync(keyPath))
console.log('ok   SSH 密钥调用参数与临时私钥')

const passwordInvocation = await buildSshInvocation(
  { type: 'ssh', id: 'ssh-pw', host: 'h', port: 22, username: 'root', authMethod: 'password', password: 'pw1' },
  'uptime',
  { askpass },
)
assert.equal(passwordInvocation.args.at(-1), 'uptime')
assert.ok(passwordInvocation.args.join(' ').includes('PreferredAuthentications=password,keyboard-interactive'))
assert.ok(passwordInvocation.args.join(' ').includes('PubkeyAuthentication=no'))
assert.equal(passwordInvocation.env.SSH_ASKPASS, askpass)
assert.equal(passwordInvocation.env.DSH_VAULT_ASKPASS, 'pw1')
assert.equal(passwordInvocation.keyDir, undefined)
console.log('ok   SSH 密码调用走 askpass')

// --- resilience ------------------------------------------------------------
ctx.credentials.records.set('dsh-credential-vault/bad-record', { kind: 'grant', payload: { v: 99 } })
assert.equal((await vault.list()).length, 2, 'corrupt records are ignored')
console.log('ok   损坏记录被忽略')

// --- proxies ---------------------------------------------------------------
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function startTargetServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ip: '203.0.113.9', path: req.url }))
  })
}

/** CONNECT authorities seen by the fake HTTP proxy, for default-port assertions. */
const connectAuthorities = []

/** CONNECT requests seen by the fake SOCKS5 server, for default-port assertions. */
const socksRequests = []

/** Minimal forward HTTP proxy: absolute-form requests plus CONNECT tunnels. */
function startHttpProxy() {
  const server = http.createServer((req, res) => {
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    const upstream = http.request({
      host: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`upstream error: ${error.message}`)
    })
    req.pipe(upstream)
  })
  server.on('connect', (req, socket, head) => {
    const authority = String(req.url)
    connectAuthorities.push(authority)
    const [host, port] = authority.split(':')
    // A CONNECT authority must always carry a port; treat a missing one as a
    // client bug rather than silently tunnelling somewhere plausible.
    if (port === undefined || port === '') {
      socket.end('HTTP/1.1 400 Bad CONNECT authority\r\n\r\n')
      return
    }
    const upstream = net.connect({ host, port: Number(port) }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
  })
  return server
}

/** Minimal SOCKS5 server with optional user/password authentication. */
function startSocks5Proxy({ username = '', password = '' } = {}) {
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0)
    let stage = 'greeting'
    const reply = (bytes) => client.write(Buffer.from(bytes))

    const pump = () => {
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return
          const count = buffer[1]
          if (buffer.length < 2 + count) return
          const methods = [...buffer.subarray(2, 2 + count)]
          buffer = buffer.subarray(2 + count)
          const needsAuth = username !== '' || password !== ''
          const selected = needsAuth ? (methods.includes(0x02) ? 0x02 : 0xff) : (methods.includes(0x00) ? 0x00 : 0xff)
          reply([0x05, selected])
          if (selected === 0xff) {
            client.end()
            return
          }
          stage = selected === 0x02 ? 'auth' : 'request'
          continue
        }
        if (stage === 'auth') {
          if (buffer.length < 2) return
          const userLength = buffer[1]
          if (buffer.length < 3 + userLength) return
          const passLength = buffer[2 + userLength]
          if (buffer.length < 3 + userLength + passLength) return
          const user = buffer.subarray(2, 2 + userLength).toString('utf8')
          const pass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8')
          buffer = buffer.subarray(3 + userLength + passLength)
          const ok = user === username && pass === password
          reply([0x01, ok ? 0x00 : 0x01])
          if (!ok) {
            client.end()
            return
          }
          stage = 'request'
          continue
        }
        if (stage !== 'request') return
        if (buffer.length < 5) return
        const atyp = buffer[3]
        let host
        let offset
        if (atyp === 0x01) {
          if (buffer.length < 10) return
          host = [...buffer.subarray(4, 8)].join('.')
          offset = 8
        } else if (atyp === 0x03) {
          const length = buffer[4]
          if (buffer.length < 5 + length + 2) return
          host = buffer.subarray(5, 5 + length).toString('utf8')
          offset = 5 + length
        } else {
          reply([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
          client.end()
          return
        }
        const port = buffer.readUInt16BE(offset)
        socksRequests.push({ host, port })
        buffer = buffer.subarray(offset + 2)
        stage = 'pipe'
        client.pause()
        const upstream = net.connect({ host, port }, () => {
          reply([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
          if (buffer.length > 0) upstream.write(buffer)
          buffer = Buffer.alloc(0)
          client.removeListener('data', onData)
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
        })
        upstream.on('error', () => client.destroy())
        return
      }
    }
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      pump()
    }
    client.on('data', onData)
    client.on('error', () => {})
  })
}

/** Minimal SOCKS4 / SOCKS4a server (CONNECT only). */
function startSocks4Proxy() {
  return net.createServer((client) => {
    const onData = (chunk) => {
      const buffer = Buffer.concat([Buffer.alloc(0), chunk])
      if (buffer.length < 9) return
      const port = buffer.readUInt16BE(2)
      let host = [...buffer.subarray(4, 8)].join('.')
      const userEnd = buffer.indexOf(0, 8)
      if (userEnd === -1) return
      let cursor = userEnd + 1
      if (host === '0.0.0.1') {
        const hostEnd = buffer.indexOf(0, cursor)
        if (hostEnd === -1) return
        host = buffer.subarray(cursor, hostEnd).toString('utf8')
        cursor = hostEnd + 1
      }
      const rest = buffer.subarray(cursor)
      client.removeListener('data', onData)
      client.pause()
      const upstream = net.connect({ host, port }, () => {
        client.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]))
        if (rest.length > 0) upstream.write(rest)
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })
      upstream.on('error', () => client.destroy())
    }
    client.on('data', onData)
    client.on('error', () => {})
  })
}

const targetServer = startTargetServer()
const targetPort = await listen(targetServer)
const httpProxyServer = startHttpProxy()
const httpProxyPort = await listen(httpProxyServer)
const socks5Server = startSocks5Proxy({ username: 'bob', password: 'secret' })
const socks5Port = await listen(socks5Server)
const socks4Server = startSocks4Proxy()
const socks4Port = await listen(socks4Server)
const targetUrl = `http://127.0.0.1:${targetPort}/whoami`

await ok('保存代理凭据并补默认端口', async () => {
  const saved = await vault.save({
    type: 'proxy',
    name: '公司出口代理',
    note: '访问外网',
    host: '10.0.0.2',
    username: 'alice',
    password: 'proxy-pass',
  })
  assert.match(saved.id, /^proxy-[0-9a-f]{12}$/)
  assert.equal(saved.protocol, 'http')
  assert.equal(saved.port, 8080)
  assert.equal(saved.url, 'http://10.0.0.2:8080')
  assert.equal('password' in saved, false)
  assert.equal(saved.hasPassword, true)
})

await ok('粘贴完整代理地址自动拆分', async () => {
  const saved = await vault.save({ type: 'proxy', name: '粘贴代理', host: 'socks5://bob:pw@1.2.3.4:1080' })
  assert.equal(saved.protocol, 'socks5')
  assert.equal(saved.host, '1.2.3.4')
  assert.equal(saved.port, 1080)
  assert.equal(saved.url, 'socks5://1.2.3.4:1080')
  const raw = await vault.revealEntry(saved.id)
  assert.equal(raw.password, 'pw')
  await vault.remove(saved.id)
})

await ok('代理摘要与提示词只含元数据', async () => {
  const entries = await vault.list()
  const proxy = entries.find((entry) => entry.type === 'proxy')
  assert.equal('password' in proxy, false)
  assert.ok(vault.promptSection().includes('代理「公司出口代理」'))
  assert.ok(vault.promptSection().includes('http://10.0.0.2:8080'))
  assert.ok(!vault.promptSection().includes('proxy-pass'))
})

await rejects('代理缺少主机被拒绝', () => vault.save({ type: 'proxy', name: 'x' }), 'invalid')
await rejects('代理协议非法被拒绝', () => vault.save({ type: 'proxy', name: 'x', host: 'h', protocol: 'ftp' }), 'invalid')
await rejects('代理端口越界被拒绝', () => vault.save({ type: 'proxy', name: 'x', host: 'h', port: 70000 }), 'invalid')

await ok('更新代理时留空保持密码、null 清除密码', async () => {
  const created = await vault.save({ type: 'proxy', name: '临时代理', host: '10.1.1.1', password: 'p1' })
  await vault.save({ id: created.id, name: '临时代理（改）' })
  assert.equal((await vault.revealEntry(created.id)).password, 'p1')
  await vault.save({ id: created.id, password: null })
  assert.equal((await vault.describe(created.id)).hasSecrets.password, false)
  await vault.remove(created.id)
})

const localHttp = await vault.save({ type: 'proxy', name: '本地 HTTP 代理', host: '127.0.0.1', port: httpProxyPort })
const localSocks5 = await vault.save({ type: 'proxy', name: '本地 SOCKS5', protocol: 'socks5', host: '127.0.0.1', port: socks5Port, username: 'bob', password: 'secret' })
const localSocks5h = await vault.save({ type: 'proxy', name: '本地 SOCKS5h', protocol: 'socks5h', host: '127.0.0.1', port: socks5Port, username: 'bob', password: 'secret' })
const localSocks4 = await vault.save({ type: 'proxy', name: '本地 SOCKS4', protocol: 'socks4', host: '127.0.0.1', port: socks4Port })
const localSocks4a = await vault.save({ type: 'proxy', name: '本地 SOCKS4a', protocol: 'socks4a', host: '127.0.0.1', port: socks4Port })
const badAuth = await vault.save({ type: 'proxy', name: '错误密码', protocol: 'socks5', host: '127.0.0.1', port: socks5Port, username: 'bob', password: 'wrong' })

const proxyTest = tools.get('proxy_test')

await ok('HTTP 代理测试：状态码、耗时与出口 IP', async () => {
  const result = await proxyTest.execute({ id: localHttp.id, url: targetUrl })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.via, 'http-proxy')
  assert.equal(result.status, 200)
  assert.equal(result.exitIp, '203.0.113.9')
  assert.ok(Number.isFinite(result.latencyMs))
})

await ok('SOCKS5 代理测试（用户名密码认证）', async () => {
  const result = await proxyTest.execute({ id: localSocks5.id, url: targetUrl })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.via, 'socks')
  assert.equal(result.exitIp, '203.0.113.9')
})

await ok('SOCKS5h 由代理解析域名', async () => {
  const result = await proxyTest.execute({ id: localSocks5h.id, url: `http://localhost:${targetPort}/whoami` })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.exitIp, '203.0.113.9')
})

await ok('SOCKS 目标省略端口时使用协议默认端口', async () => {
  for (const [entry, url, expected] of [
    [localSocks5, 'http://127.0.0.1/x', 80],
    [localSocks5, 'https://127.0.0.1/x', 443],
  ]) {
    socksRequests.length = 0
    const result = await proxyTest.execute({ id: entry.id, url })
    // The fake target only answers plain HTTP, so 443 fails — we only assert
    // that the port reached the proxy as a number instead of `undefined`.
    assert.equal(socksRequests.length > 0, true, 'SOCKS request reached the proxy')
    assert.equal(socksRequests[0].port, expected, `expected port ${expected} in the SOCKS request`)
    assert.equal(result.protocol, 'socks5')
  }
})

await ok('SOCKS4 代理测试', async () => {
  const result = await proxyTest.execute({ id: localSocks4.id, url: targetUrl })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.via, 'socks')
})

await ok('SOCKS4a 代理测试（域名交由代理解析）', async () => {
  const result = await proxyTest.execute({ id: localSocks4a.id, url: `http://localhost:${targetPort}/whoami` })
  assert.equal(result.ok, true, String(result.error))
})

await ok('代理认证失败返回结构化错误', async () => {
  const result = await proxyTest.execute({ id: badAuth.id, url: targetUrl })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /认证/)
})

await ok('HTTPS 目标省略端口时 CONNECT 使用 443', async () => {
  connectAuthorities.length = 0
  const result = await proxyTest.execute({ id: localHttp.id, url: 'https://127.0.0.1/x' })
  assert.equal(result.ok, false, 'plain HTTP upstream cannot complete TLS')
  assert.deepEqual(connectAuthorities, ['127.0.0.1:443'], 'default port must appear in the authority')
})

await ok('CONNECT 隧道失败给出可读错误', async () => {
  const result = await proxyTest.execute({ id: localHttp.id, url: `https://127.0.0.1:${targetPort}/x` })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /TLS/)
})

await ok('代理不可达时返回错误而不抛异常', async () => {
  const closed = await vault.save({ type: 'proxy', name: '关闭的端口', host: '127.0.0.1', port: 9 })
  const result = await proxyTest.execute({ id: closed.id, url: targetUrl, timeoutMs: 2000 })
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
  await vault.remove(closed.id)
})

await rejects('proxy_test 拒绝非代理凭据', () => proxyTest.execute({ id: sshEntry.id }), 'invalid')
await rejects('proxy_test 缺少 id 被拒绝', () => proxyTest.execute({}), 'invalid')

await ok('出口 IP 解析支持常见响应格式', async () => {
  assert.equal(extractExitIp('{"ip":"198.51.100.7"}'), '198.51.100.7')
  assert.equal(extractExitIp('198.51.100.8\n'), '198.51.100.8')
  assert.equal(extractExitIp('fl=abc\nip=198.51.100.9\nts=1\n'), '198.51.100.9')
  assert.equal(extractExitIp('<html>nope</html>'), undefined)
})

targetServer.close()
httpProxyServer.close()
socks5Server.close()
socks4Server.close()

console.log(`\nALL PASS (${passed} checks + assertions)`)
