/**
 * Proxy connectivity testing for `dsh-credential-vault`.
 *
 * Opens a tunnel through a stored proxy (HTTP/HTTPS `CONNECT`, SOCKS5 or
 * SOCKS4) and runs one HTTP GET through it, so the Settings page and the
 * `proxy_test` tool can answer "does this proxy work, how fast is it, and what
 * IP do I exit as?" without a runtime dependency, and without the proxy
 * password ever reaching a command line or a URL string handed to a shell.
 *
 * SOCKS5 and SOCKS4 handshakes are implemented directly on a TCP socket;
 * `socks5h` / `socks4a` let the proxy resolve the target host name.
 *
 * @module dsh-credential-vault/proxy
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'

import { VaultError, buildProxyUrl, proxyPort } from './vault.js'

/** Where `proxy_test` goes when the caller does not name a target. */
export const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json'

const MAX_BODY = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const USER_AGENT = 'dsh-credential-vault/proxy-test'

/** SOCKS5 reply codes (RFC 1928 §6). */
const SOCKS5_ERRORS = Object.freeze({
  0x01: '代理内部错误',
  0x02: '规则禁止该连接',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '目标拒绝连接',
  0x06: 'TTL 过期',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
})

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function remaining(deadline) {
  return Math.max(200, deadline - Date.now())
}

function clampTimeout(value) {
  const number = Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(120_000, number))
}

/**
 * Resolve the test target; anything that is not http(s) is a caller error.
 * @param {string|undefined} raw - user supplied URL.
 * @returns {URL} parsed target.
 */
function targetUrl(raw) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_TEST_URL
  let url
  try {
    url = new URL(value)
  } catch {
    throw new VaultError('invalid', `测试目标不是有效的 URL：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VaultError('invalid', '测试目标只支持 http:// 或 https://。')
  }
  return url
}

function hostHeader(url) {
  return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
}

/**
 * Effective port of a parsed target. WHATWG `URL` drops default ports, so
 * `url.port` is `''` for `https://host/path` and must not reach `CONNECT`,
 * SOCKS or `http.request` as an empty string.
 * @param {URL} url - parsed target.
 * @returns {number} numeric port.
 */
function targetPort(url) {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function requestPath(url) {
  return `${url.pathname === '' ? '/' : url.pathname}${url.search}`
}

function basicAuthHeader(entry) {
  const username = typeof entry.username === 'string' ? entry.username : ''
  const password = typeof entry.password === 'string' ? entry.password : ''
  if (username === '' && password === '') return undefined
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

/**
 * Tiny buffered reader for protocol handshakes: `read(n)` resolves with exactly
 * n bytes, and `detach()` pushes any surplus back so the HTTP parser sees it.
 */
class ByteReader {
  constructor(socket) {
    this.socket = socket
    this.chunks = []
    this.buffered = 0
    this.pending = null
    this.error = null
    this.closed = false
    this.onData = (chunk) => {
      this.chunks.push(chunk)
      this.buffered += chunk.length
      this.pump()
    }
    this.onError = (error) => {
      this.error = error
      this.pump()
    }
    this.onClose = () => {
      this.closed = true
      this.pump()
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  read(length) {
    if (this.pending !== null) return Promise.reject(new VaultError('proxy-failed', '握手状态混乱。'))
    return new Promise((resolve, reject) => {
      this.pending = { length, resolve, reject }
      this.pump()
    })
  }

  pump() {
    const pending = this.pending
    if (pending === null) return
    if (this.buffered >= pending.length) {
      const all = Buffer.concat(this.chunks)
      const head = all.subarray(0, pending.length)
      const rest = all.subarray(pending.length)
      this.pending = null
      this.chunks = rest.length > 0 ? [rest] : []
      this.buffered = rest.length
      pending.resolve(head)
      return
    }
    if (this.error !== null) {
      this.pending = null
      pending.reject(new VaultError('proxy-failed', `代理连接出错：${this.error.message}`))
      return
    }
    if (this.closed) {
      this.pending = null
      pending.reject(new VaultError('proxy-failed', '代理在握手完成前关闭了连接。'))
    }
  }

  detach() {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('error', this.onError)
    this.socket.removeListener('close', this.onClose)
    if (this.buffered > 0) {
      const rest = Buffer.concat(this.chunks)
      this.chunks = []
      this.buffered = 0
      this.socket.unshift(rest)
    }
  }
}

function connectTcp(host, port, deadline) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new VaultError('proxy-failed', `连接代理 ${host}:${port} 超时。`))
    }, remaining(deadline))
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setNoDelay(true)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(new VaultError('proxy-failed', `连接代理 ${host}:${port} 失败：${error.message}`))
    })
  })
}

function startTls(socket, host, deadline) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      servername: isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    const timer = setTimeout(() => {
      tlsSocket.destroy()
      reject(new VaultError('proxy-failed', '与目标站点建立 TLS 连接超时。'))
    }, remaining(deadline))
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(tlsSocket)
    })
    tlsSocket.once('error', (error) => {
      clearTimeout(timer)
      reject(new VaultError('proxy-failed', `与目标站点建立 TLS 连接失败：${error.message}`))
    })
  })
}

function ipv6ToBuffer(address) {
  const [head, tail] = address.split('::')
  const groups = (part) => (part === '' ? [] : part.split(':').flatMap((group) => {
    if (group.includes('.')) {
      const octets = group.split('.').map((value) => Number.parseInt(value, 10))
      return [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)]
    }
    return [Number.parseInt(group, 16)]
  }))
  const headGroups = groups(head ?? '')
  const tailGroups = groups(tail ?? '')
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length)
  const all = [...headGroups, ...Array.from({ length: missing }, () => 0), ...tailGroups]
  const buffer = Buffer.alloc(16)
  all.slice(0, 8).forEach((value, index) => buffer.writeUInt16BE(value & 0xffff, index * 2))
  return buffer
}

async function resolveIpv4(host) {
  try {
    const { address } = await dnsLookup(host, { family: 4 })
    return Buffer.from(address.split('.').map((value) => Number.parseInt(value, 10)))
  } catch (error) {
    throw new VaultError('proxy-failed', `无法在本机解析目标主机 ${host}：${messageOf(error)}（可改用 socks5h / socks4a 让代理解析）。`)
  }
}

function socksDomain(host) {
  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw new VaultError('invalid', '目标主机名过长（最多 255 字节）。')
  return Buffer.concat([Buffer.from([0x03, name.length]), name])
}

async function socks5Address(host, remoteDns) {
  const literal = isIP(host)
  if (literal === 4) return Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map((value) => Number.parseInt(value, 10)))])
  if (literal === 6) return Buffer.concat([Buffer.from([0x04]), ipv6ToBuffer(host)])
  if (remoteDns) return socksDomain(host)
  return Buffer.concat([Buffer.from([0x01]), await resolveIpv4(host)])
}

async function socks5Handshake(entry, target, socket, reader, remoteDns) {
  const username = typeof entry.username === 'string' ? entry.username : ''
  const password = typeof entry.password === 'string' ? entry.password : ''
  const withAuth = username !== '' || password !== ''
  socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))

  const greeting = await reader.read(2)
  if (greeting[0] !== 0x05) throw new VaultError('proxy-failed', '代理返回了无效的 SOCKS 版本号。')
  const method = greeting[1]
  if (method === 0xff) throw new VaultError('proxy-failed', '代理拒绝了所有可用的认证方式。')
  if (method === 0x02) {
    const user = Buffer.from(username, 'utf8')
    const pass = Buffer.from(password, 'utf8')
    if (user.length > 255 || pass.length > 255) throw new VaultError('invalid', 'SOCKS5 用户名或密码过长（最多 255 字节）。')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const reply = await reader.read(2)
    if (reply[1] !== 0x00) throw new VaultError('proxy-failed', '代理认证失败，请检查用户名和密码。')
  } else if (method !== 0x00) {
    throw new VaultError('proxy-failed', `代理要求不支持的认证方式（0x${method.toString(16)}）。`)
  }

  const port = Buffer.alloc(2)
  port.writeUInt16BE(targetPort(target))
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), await socks5Address(target.hostname, remoteDns), port]))

  const reply = await reader.read(4)
  if (reply[0] !== 0x05) throw new VaultError('proxy-failed', '代理返回了无效的 SOCKS5 响应。')
  if (reply[1] !== 0x00) {
    throw new VaultError('proxy-failed', `SOCKS5 代理拒绝连接：${SOCKS5_ERRORS[reply[1]] ?? `错误码 0x${reply[1].toString(16)}`}。`)
  }
  // Consume the bound address the proxy reports, so no stray bytes remain.
  if (reply[3] === 0x01) await reader.read(4 + 2)
  else if (reply[3] === 0x04) await reader.read(16 + 2)
  else if (reply[3] === 0x03) {
    const length = await reader.read(1)
    await reader.read(length[0] + 2)
  } else {
    throw new VaultError('proxy-failed', `代理返回了未知的地址类型（0x${reply[3].toString(16)}）。`)
  }
}

async function socks4Handshake(entry, target, socket, reader, remoteDns) {
  const user = Buffer.from(typeof entry.username === 'string' ? entry.username : '', 'utf8')
  const host = target.hostname
  const literal = isIP(host)
  const useDomain = literal === 0 && remoteDns
  let address
  if (literal === 4) address = Buffer.from(host.split('.').map((value) => Number.parseInt(value, 10)))
  else if (useDomain) address = Buffer.from([0x00, 0x00, 0x00, 0x01])
  else address = await resolveIpv4(host)

  const port = Buffer.alloc(2)
  port.writeUInt16BE(targetPort(target))
  const parts = [Buffer.from([0x04, 0x01]), port, address, user, Buffer.from([0x00])]
  if (useDomain) parts.push(Buffer.from(host, 'utf8'), Buffer.from([0x00]))
  socket.write(Buffer.concat(parts))

  const reply = await reader.read(8)
  if (reply[0] !== 0x00 || reply[1] !== 0x5a) {
    throw new VaultError('proxy-failed', `SOCKS4 代理拒绝连接（状态码 0x${reply[1].toString(16)}）。`)
  }
}

async function openSocksTunnel(entry, target, deadline) {
  const protocol = entry.protocol
  const remoteDns = protocol === 'socks5h' || protocol === 'socks4a'
  const socket = await connectTcp(entry.host, entry.port ?? proxyPort(protocol), deadline)
  const reader = new ByteReader(socket)
  try {
    if (protocol === 'socks5' || protocol === 'socks5h') {
      await socks5Handshake(entry, target, socket, reader, remoteDns)
    } else {
      await socks4Handshake(entry, target, socket, reader, remoteDns)
    }
  } catch (error) {
    socket.destroy()
    throw error
  }
  reader.detach()
  return socket
}

function openConnectTunnel(entry, target, deadline) {
  const secureProxy = entry.protocol === 'https'
  const requestFn = secureProxy ? httpsRequest : httpRequest
  const authority = `${target.hostname}:${targetPort(target)}`
  const headers = { host: authority }
  const auth = basicAuthHeader(entry)
  if (auth !== undefined) headers['proxy-authorization'] = auth

  return new Promise((resolve, reject) => {
    const req = requestFn({
      host: entry.host,
      port: entry.port ?? proxyPort(entry.protocol),
      method: 'CONNECT',
      path: authority,
      headers,
      timeout: remaining(deadline),
    })
    req.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new VaultError('proxy-failed', `代理拒绝建立隧道（HTTP ${response.statusCode}）。`))
        return
      }
      if (head !== undefined && head.length > 0) socket.unshift(head)
      startTls(socket, target.hostname, deadline).then(resolve, reject)
    })
    req.once('timeout', () => req.destroy(new VaultError('proxy-failed', '代理响应超时。')))
    req.once('error', (error) => reject(error instanceof VaultError ? error : new VaultError('proxy-failed', `代理连接失败：${messageOf(error)}`)))
    req.end()
  })
}

function readResponse(response, settle, via) {
  let finished = false
  const chunks = []
  let size = 0
  let truncated = false
  const finish = () => {
    if (finished) return
    finished = true
    settle.resolve({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      truncated,
      via,
    })
  }
  response.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      truncated = true
      response.destroy()
      finish()
      return
    }
    chunks.push(chunk)
  })
  response.once('end', finish)
  response.once('close', finish)
  response.once('error', (error) => {
    if (finished) return
    finished = true
    settle.reject(error)
  })
}

function sendOverSocket(socket, target, via, deadline) {
  return new Promise((resolve, reject) => {
    const settle = { resolve, reject }
    const req = httpRequest({
      host: target.hostname,
      port: targetPort(target),
      method: 'GET',
      path: requestPath(target),
      headers: { host: hostHeader(target), 'user-agent': USER_AGENT, accept: '*/*', connection: 'close' },
      createConnection: () => socket,
      timeout: remaining(deadline),
    })
    req.once('response', (response) => readResponse(response, settle, via))
    req.once('timeout', () => req.destroy(new VaultError('proxy-failed', '目标站点响应超时。')))
    req.once('error', (error) => reject(error instanceof VaultError ? error : new VaultError('proxy-failed', `请求目标站点失败：${messageOf(error)}`)))
    req.end()
  })
}

function sendViaHttpProxyAbsolute(entry, target, deadline) {
  const secureProxy = entry.protocol === 'https'
  const requestFn = secureProxy ? httpsRequest : httpRequest
  const headers = {
    host: hostHeader(target),
    'user-agent': USER_AGENT,
    accept: '*/*',
    connection: 'close',
  }
  const auth = basicAuthHeader(entry)
  if (auth !== undefined) headers['proxy-authorization'] = auth

  return new Promise((resolve, reject) => {
    const settle = { resolve, reject }
    const req = requestFn({
      host: entry.host,
      port: entry.port ?? proxyPort(entry.protocol),
      method: 'GET',
      path: target.href,
      headers,
      servername: secureProxy ? entry.host : undefined,
      timeout: remaining(deadline),
    })
    req.once('response', (response) => readResponse(response, settle, 'http-proxy'))
    req.once('timeout', () => req.destroy(new VaultError('proxy-failed', '代理响应超时。')))
    req.once('error', (error) => reject(error instanceof VaultError ? error : new VaultError('proxy-failed', `代理连接失败：${messageOf(error)}`)))
    req.end()
  })
}

/** Pull an address out of common "what is my IP" response shapes. */
export function extractExitIp(body) {
  const value = typeof body === 'string' ? body.trim() : ''
  if (value === '') return undefined
  if (value.startsWith('{')) {
    try {
      const json = JSON.parse(value)
      for (const key of ['ip', 'query', 'origin', 'IP', 'ip_address', 'YourFuckingIPAddress']) {
        const candidate = json?.[key]
        if (typeof candidate === 'string' && isIP(candidate.trim()) !== 0) return candidate.trim()
        if (typeof candidate === 'string' && candidate.includes(',') && isIP(candidate.split(',')[0].trim()) !== 0) {
          return candidate.split(',')[0].trim()
        }
      }
    } catch {
      // Not JSON after all; fall through to the line scan.
    }
  }
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim()
    const keyed = /^ip=(.+)$/u.exec(trimmed)
    if (keyed !== null && isIP(keyed[1].trim()) !== 0) return keyed[1].trim()
    if (isIP(trimmed) !== 0) return trimmed
  }
  return undefined
}

/**
 * Test one stored proxy by fetching a target URL through it.
 * @param {object} entry - proxy entry (`protocol`, `host`, `port`, `username`, `password`).
 * @param {{ url?: string, timeoutMs?: number }} [options] - target URL and timeout.
 * @returns {Promise<object>} structured result; never throws for network failures.
 */
export async function testProxy(entry, options = {}) {
  const started = Date.now()
  const timeoutMs = clampTimeout(options.timeoutMs)
  const deadline = started + timeoutMs
  const result = {
    ok: false,
    protocol: entry.protocol ?? 'http',
    proxy: buildProxyUrl(entry),
    target: DEFAULT_TEST_URL,
    latencyMs: 0,
  }

  let target
  try {
    target = targetUrl(options.url)
  } catch (error) {
    result.error = messageOf(error)
    return result
  }
  result.target = target.href

  try {
    let response
    if (entry.protocol === 'http' || entry.protocol === 'https') {
      response = target.protocol === 'https:'
        ? await (async () => {
          const socket = await openConnectTunnel(entry, target, deadline)
          return sendOverSocket(socket, target, 'connect', deadline)
        })()
        : await sendViaHttpProxyAbsolute(entry, target, deadline)
    } else {
      const socket = await openSocksTunnel(entry, target, deadline)
      const stream = target.protocol === 'https:' ? await startTls(socket, target.hostname, deadline) : socket
      response = await sendOverSocket(stream, target, 'socks', deadline)
    }

    result.latencyMs = Date.now() - started
    result.status = response.status
    result.via = response.via
    result.truncated = response.truncated === true
    const exitIp = extractExitIp(response.body)
    if (exitIp !== undefined) result.exitIp = exitIp
    if (response.status >= 200 && response.status < 400) {
      result.ok = true
    } else if (response.status === 407) {
      result.error = '代理要求认证（HTTP 407），请检查用户名和密码。'
    } else {
      result.error = `代理返回了 HTTP ${response.status}。`
    }
  } catch (error) {
    result.latencyMs = Date.now() - started
    result.error = messageOf(error)
  }
  return result
}
