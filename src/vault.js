/**
 * Credential records for `dsh-credential-vault`.
 *
 * Entries live in the Harness credential store (`ctx.credentials`), one
 * record per entry under `<scope>/<id>` with `kind: 'grant'`. That store owns
 * the file, its owner-only permissions, atomic writes and its change watcher,
 * so this module only validates and projects entries.
 *
 * Nothing here ever hands a secret to a caller that did not ask for one:
 * summaries and masked projections are the default, and `revealEntry()` is the
 * only path that returns plaintext.
 *
 * @module dsh-credential-vault/vault
 */
import { randomBytes } from 'node:crypto'

/** Owning scope; must match the plugin name grammar `<scope>/<id>`. */
export const SCOPE = 'dsh-credential-vault'

/** Supported credential kinds. */
export const TYPES = Object.freeze(['web', 'github', 'ssh'])

/** Secret fields per kind; everything here is masked unless revealed. */
export const SECRET_FIELDS = Object.freeze({
  web: Object.freeze(['password']),
  github: Object.freeze(['token']),
  ssh: Object.freeze(['password', 'privateKey', 'passphrase']),
})

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/

const LIMITS = Object.freeze({
  name: 80,
  note: 4000,
  url: 2048,
  username: 200,
  host: 255,
  email: 200,
  password: 512,
  token: 4096,
  privateKey: 32768,
  passphrase: 512,
})

/** A rejected vault operation; `code` reaches tool results and the UI. */
export class VaultError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

function fail(code, message) {
  throw new VaultError(code, message)
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function limited(value, max, label) {
  if (value.length > max) fail('invalid', `${label} 太长了（最多 ${max} 个字符）。`)
  return value
}

function trimmed(value, max, label) {
  return limited(text(value).trim(), max, label)
}

function nowIso() {
  return new Date().toISOString()
}

function newId(type) {
  return `${type}-${randomBytes(6).toString('hex')}`
}

/** Normalize a URL, adding `https://` when the scheme is missing. */
function normalizeUrl(raw) {
  const value = trimmed(raw, LIMITS.url, '网址')
  if (value === '') fail('invalid', '网页系统需要填写网址。')
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    fail('invalid', `网址不是有效的 URL：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('invalid', '网址只支持 http:// 或 https://。')
  }
  return url.toString()
}

function normalizePort(raw) {
  if (raw === undefined || raw === null || raw === '') return 22
  const port = typeof raw === 'number' ? raw : Number.parseInt(text(raw), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid', 'SSH 端口必须是 1-65535 之间的整数。')
  return port
}

/**
 * Read one secret field from user input.
 * @returns {string|undefined} the new value, '' for "clear", or undefined for "keep".
 */
function secretInput(input, field) {
  if (!Object.hasOwn(input, field)) return undefined
  const raw = input[field]
  if (raw === null) return ''
  if (typeof raw !== 'string') return undefined
  if (raw.length === 0) return undefined
  return limited(raw, LIMITS[field] ?? LIMITS.password, '密钥')
}

function pickSecret(entry, field, next) {
  if (next === undefined) return
  if (next === '') delete entry[field]
  else entry[field] = next
}

/**
 * Build the canonical entry from validated input.
 * @param {object} input - caller payload (UI or tool).
 * @param {object|undefined} previous - stored entry when updating.
 * @returns {object} a JSON-safe entry ready for the credential store.
 */
function buildEntry(input, previous) {
  const type = input.type ?? previous?.type
  if (!TYPES.includes(type)) fail('invalid', '凭据类型必须是 web、github 或 ssh。')

  const entry = previous ? structuredClone(previous) : { id: '', type, createdAt: nowIso() }
  entry.type = type
  entry.id = previous?.id ?? ''

  if (Object.hasOwn(input, 'name')) entry.name = trimmed(input.name, LIMITS.name, '名称')
  if (Object.hasOwn(input, 'note')) entry.note = limited(text(input.note).trim(), LIMITS.note, '备注')
  entry.name = entry.name ?? ''
  entry.note = entry.note ?? ''
  entry.updatedAt = nowIso()

  if (type === 'web') {
    if (Object.hasOwn(input, 'url')) entry.url = normalizeUrl(input.url)
    if (Object.hasOwn(input, 'username')) entry.username = trimmed(input.username, LIMITS.username, '账户')
    pickSecret(entry, 'password', secretInput(input, 'password'))
    delete entry.host
    delete entry.port
    delete entry.authMethod
    delete entry.token
    delete entry.email
    delete entry.privateKey
    delete entry.passphrase
  } else if (type === 'github') {
    if (Object.hasOwn(input, 'username')) entry.username = trimmed(input.username, LIMITS.username, 'GitHub 用户名')
    if (Object.hasOwn(input, 'email')) entry.email = trimmed(input.email, LIMITS.email, '提交邮箱')
    pickSecret(entry, 'token', secretInput(input, 'token'))
    delete entry.url
    delete entry.password
    delete entry.host
    delete entry.port
    delete entry.authMethod
    delete entry.privateKey
    delete entry.passphrase
  } else {
    if (Object.hasOwn(input, 'host')) entry.host = trimmed(input.host, LIMITS.host, '主机')
    if (Object.hasOwn(input, 'port')) entry.port = normalizePort(input.port)
    if (Object.hasOwn(input, 'username')) entry.username = trimmed(input.username, LIMITS.username, '登录用户')
    pickSecret(entry, 'password', secretInput(input, 'password'))
    pickSecret(entry, 'privateKey', secretInput(input, 'privateKey'))
    pickSecret(entry, 'passphrase', secretInput(input, 'passphrase'))
    if (Object.hasOwn(input, 'authMethod')) {
      const method = text(input.authMethod)
      if (method !== 'password' && method !== 'key') fail('invalid', 'SSH 认证方式必须是 password 或 key。')
      entry.authMethod = method
    }
    entry.port = entry.port ?? 22
    entry.authMethod = entry.authMethod ?? (entry.privateKey ? 'key' : 'password')
    delete entry.url
    delete entry.token
    delete entry.email
  }

  if (entry.name === '') fail('invalid', '请填写凭据名称。')

  if (type === 'web') {
    if (!entry.url) fail('invalid', '网页系统需要填写网址。')
    if (!entry.username) fail('invalid', '网页系统需要填写账户。')
    entry.username = entry.username || ''
  } else if (type === 'github') {
    if (!entry.username) fail('invalid', 'GitHub 凭据需要填写用户名。')
    if (!entry.token) fail('invalid', 'GitHub 凭据需要填写访问令牌（PAT）。')
  } else {
    if (!entry.host) fail('invalid', 'SSH 凭据需要填写主机地址。')
    if (!entry.username) fail('invalid', 'SSH 凭据需要填写登录用户。')
    if (entry.authMethod === 'key' && !entry.privateKey) fail('invalid', 'SSH 密钥登录需要填写私钥内容。')
    if (entry.authMethod === 'password' && !entry.password) fail('invalid', 'SSH 密码登录需要填写密码。')
  }

  return entry
}

/** Public projection: metadata only, never a secret. */
export function toSummary(entry) {
  const summary = {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    note: entry.note ?? '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
  if (entry.type === 'web') {
    summary.url = entry.url
    summary.username = entry.username
    summary.hasPassword = typeof entry.password === 'string' && entry.password.length > 0
  } else if (entry.type === 'github') {
    summary.username = entry.username
    summary.email = entry.email ?? ''
    summary.hasToken = typeof entry.token === 'string' && entry.token.length > 0
  } else {
    summary.host = entry.host
    summary.port = entry.port ?? 22
    summary.username = entry.username
    summary.authMethod = entry.authMethod ?? 'password'
    summary.hasPassword = typeof entry.password === 'string' && entry.password.length > 0
    summary.hasPrivateKey = typeof entry.privateKey === 'string' && entry.privateKey.length > 0
    summary.hasPassphrase = typeof entry.passphrase === 'string' && entry.passphrase.length > 0
  }
  return summary
}

/** Mask a secret for display: keep nothing but its length class. */
export function maskSecret(name) {
  return name === 'privateKey' ? '••••（已保存私钥）' : '••••••••'
}

/** One-line target used by lists and the prompt section. */
export function describeTarget(entry) {
  if (entry.type === 'web') return entry.url ?? ''
  if (entry.type === 'github') return entry.username ? `github.com/${entry.username}` : 'github.com'
  return `${entry.username ?? ''}@${entry.host ?? ''}:${entry.port ?? 22}`
}

/**
 * Credential store projection used by tools, the Settings page and the prompt
 * section.
 */
export class Vault {
  /**
   * @param {object} ctx - Host plugin context (needs `credentials`).
   * @param {object} settings - resolved plugin config.
   */
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    this.cache = null
  }

  keyOf(id) {
    return `${SCOPE}/${id}`
  }

  async readRaw(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) fail('invalid', '凭据 id 不合法。')
    const record = await this.ctx.credentials.readRecord(this.keyOf(id))
    if (record === undefined) fail('not-found', `没有找到 id 为 ${id} 的凭据。`)
    const payload = record?.kind === 'grant' ? record.payload : undefined
    if (!payload || payload.v !== 1 || typeof payload.id !== 'string') {
      fail('corrupt', `凭据 ${id} 的数据格式无法识别。`)
    }
    return payload
  }

  async readAll() {
    const records = await this.ctx.credentials.listRecords()
    const prefix = `${SCOPE}/`
    const entries = []
    for (const record of records) {
      const key = String(record.key ?? '')
      if (!key.startsWith(prefix)) continue
      const stored = await this.ctx.credentials.readRecord(key)
      const payload = stored?.kind === 'grant' ? stored.payload : undefined
      if (!payload || payload.v !== 1 || typeof payload.id !== 'string') continue
      if (!TYPES.includes(payload.type)) continue
      entries.push(payload)
    }
    entries.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return entries
  }

  async refresh() {
    const entries = await this.readAll()
    this.cache = entries
    return entries
  }

  /**
   * List entries without secrets.
   * @returns {Promise<object[]>} summaries, newest first.
   */
  async list() {
    return (await this.refresh()).map(toSummary)
  }

  /** Full entry with secrets masked. */
  async describe(id) {
    const entry = await this.readRaw(id)
    return this.project(entry, false)
  }

  /** Full entry with plaintext secrets; the tool layer gates who may ask. */
  async revealEntry(id) {
    const entry = await this.readRaw(id)
    return this.project(entry, true)
  }

  /** Project one entry for a caller, masking every secret unless `reveal`. */
  project(entry, reveal) {
    const copy = structuredClone(entry)
    for (const field of SECRET_FIELDS[entry.type] ?? []) {
      if (typeof copy[field] === 'string' && copy[field].length > 0) {
        copy[field] = reveal ? copy[field] : maskSecret(field)
      }
    }
    copy.hasSecrets = {}
    for (const field of SECRET_FIELDS[entry.type] ?? []) {
      copy.hasSecrets[field] = typeof entry[field] === 'string' && entry[field].length > 0
    }
    return copy
  }

  /** Reveal exactly one secret field, for the Settings UI "显示" button. */
  async revealField(id, field) {
    const entry = await this.readRaw(id)
    const allowed = SECRET_FIELDS[entry.type] ?? []
    if (!allowed.includes(field)) fail('invalid', `凭据 ${id} 没有可显示的字段 ${field}。`)
    const value = entry[field]
    if (typeof value !== 'string' || value.length === 0) fail('not-found', '该字段尚未保存。')
    return { value }
  }

  /**
   * Create or update one entry.
   * @param {object} input - entry fields; `id` selects an update.
   * @returns {Promise<object>} the saved summary.
   */
  async save(input) {
    if (input === null || typeof input !== 'object') fail('invalid', '缺少凭据内容。')
    const previous = typeof input.id === 'string' && input.id !== '' ? await this.readRaw(input.id) : undefined
    const entry = buildEntry(input, previous)
    if (!previous) {
      entry.id = newId(entry.type)
      entry.createdAt = nowIso()
    }
    entry.v = 1
    await this.ctx.credentials.modifyRecord(this.keyOf(entry.id), async () => ({
      kind: 'grant',
      payload: entry,
    }))
    this.invalidate()
    void this.refresh().catch(() => {})
    return toSummary(entry)
  }

  /** Remove one entry. */
  async remove(id) {
    await this.readRaw(id)
    await this.ctx.credentials.deleteRecord(this.keyOf(id))
    this.invalidate()
    void this.refresh().catch(() => {})
    return { id }
  }

  /** Drop the cached index (external edits through the credential store). */
  invalidate() {
    this.cache = null
  }

  /** Best-effort warm-up so the first prompt already lists known entries. */
  prime() {
    void this.refresh().catch(() => {})
  }

  /** Short system-prompt section: names, kinds and targets, never secrets. */
  promptSection() {
    const entries = this.cache
    if (entries === null || entries.length === 0) return ''
    const limit = Math.max(1, this.settings.maxPromptEntries ?? 12)
    const lines = entries.slice(0, limit).map((entry) => {
      const note = (entry.note ?? '').replace(/\s+/gu, ' ').slice(0, 80)
      const kind = entry.type === 'web' ? '网页' : entry.type === 'github' ? 'GitHub' : 'SSH'
      return `- ${kind}「${entry.name}」(id: ${entry.id}) — ${describeTarget(entry)}${note ? `；用途：${note}` : ''}`
    })
    const more = entries.length > limit ? `（还有 ${entries.length - limit} 条，用 credential_list 查看。）` : ''
    return [
      '### 凭据库（credential-vault）',
      '用户在「凭据管家」里保存了以下凭据，明文不在提示词中：',
      ...lines,
      more,
      '使用方式：credential_list 查看全部；credential_get 传 reveal=true 才会返回密码/令牌明文（会写入会话记录）；SSH 命令优先用 ssh_exec 直接执行，避免明文出现在命令里。',
    ]
      .filter((line) => line !== '')
      .join('\n')
  }
}
