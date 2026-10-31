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
assert.deepEqual([...tools.keys()].sort(), ['credential_get', 'credential_list', 'credential_save', 'ssh_exec'])
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

console.log(`\nALL PASS (${passed} checks + assertions)`)
