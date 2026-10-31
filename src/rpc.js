/**
 * Browser ⇄ Host channel for the Settings page.
 *
 * The Harness Connection service's private RPC channel (`rpc.handle`) registers
 * its route against the *provider* context in this build, so it cannot be used
 * from a third-party plugin. This module instead registers its own prefix route
 * on the Host web server and runs the Connection admission check itself: only
 * an authenticated browser peer of this Host passes the Host/Origin fence and
 * the signed session cookie, exactly like the built-in `/api` route.
 *
 * @module dsh-credential-vault/rpc
 */
import { VaultError } from './vault.js'

/** Route prefix; the browser half posts to `<prefix>/<endpoint>`. */
export const RPC_CHANNEL = '/credential-vault'

const MAX_BODY_BYTES = 1024 * 1024
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function failure(error) {
  if (error instanceof VaultError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'internal', message } }
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.byteLength
    if (total > MAX_BODY_BYTES) throw new VaultError('too-large', '请求体过大。')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new VaultError('invalid', '请求体不是合法的 JSON。')
  }
}

function record(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}

/**
 * Register the vault's HTTP endpoints.
 * @param {object} web - context injected with `connection` and `webServer`.
 * @param {import('./vault.js').Vault} vault - vault service.
 * @param {object} settings - resolved plugin config.
 */
export function registerRpc(web, vault, settings) {
  const handlers = {
    async list() {
      const entries = await vault.list()
      return { entries, count: entries.length, version: 1 }
    },
    async save(payload) {
      return { entry: await vault.save(record(payload)) }
    },
    async remove(payload) {
      const { id } = record(payload)
      if (typeof id !== 'string' || id === '') throw new VaultError('invalid', '缺少凭据 id。')
      return await vault.remove(id)
    },
    async reveal(payload) {
      const { id, field } = record(payload)
      if (typeof id !== 'string' || typeof field !== 'string') throw new VaultError('invalid', '缺少凭据 id 或字段名。')
      return await vault.revealField(id, field)
    },
    async status() {
      const entries = await vault.list()
      return {
        ok: true,
        count: entries.length,
        version: 1,
        store: 'credentials',
        allowAgentReveal: settings.allowAgentReveal !== false,
        allowAgentWrite: settings.allowAgentWrite !== false,
      }
    },
  }

  const handler = async (req, res) => {
    let admission
    try {
      admission = web.connection.admit(req)
    } catch (error) {
      web.logger?.warn?.(error)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('admission failed')
      return
    }
    if (admission.rejection !== undefined) {
      res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(RPC_CHANNEL.length + 1) : ''
    if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
      res.end('method not allowed')
      return
    }

    const fn = handlers[endpoint]
    if (fn === undefined) {
      send(res, 404, { ok: false, error: { code: 'not-found', message: `未知的接口：${endpoint}` } })
      return
    }

    try {
      const payload = await readJson(req)
      const value = await fn(payload)
      send(res, 200, { ok: true, value })
    } catch (error) {
      send(res, 200, failure(error))
    }
  }

  web.effect(
    () => web.webServer.register({ kind: 'prefix', path: RPC_CHANNEL, handler }),
    'credential-vault: settings route',
  )
  web.on('credentials/record-updated', () => vault.invalidate())
}
