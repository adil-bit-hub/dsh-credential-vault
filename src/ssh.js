/**
 * SSH execution for `dsh-credential-vault`.
 *
 * Runs the platform OpenSSH client against a stored server credential so the
 * password or key never has to appear in the command line, the shell history
 * or the tool arguments. Password authentication goes through `SSH_ASKPASS`:
 * Windows gets a tiny helper compiled once with the .NET Framework compiler
 * (Windows OpenSSH runs the askpass program through `posix_spawnp`, so a batch
 * file is not enough), other platforms get a POSIX shell script.
 *
 * @module dsh-credential-vault/ssh
 */
import { spawn } from 'node:child_process'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VaultError } from './vault.js'

const MAX_OUTPUT = 200_000
const ASKPASS_VAR = 'DSH_VAULT_ASKPASS'

const ASKPASS_CS = `using System;
using System.Text;
class DshAskpass {
  static int Main() {
    string secret = Environment.GetEnvironmentVariable("DSH_VAULT_ASKPASS");
    if (secret == null) return 1;
    byte[] bytes = new UTF8Encoding(false).GetBytes(secret);
    using (System.IO.Stream output = Console.OpenStandardOutput()) {
      output.Write(bytes, 0, bytes.Length);
      output.Flush();
    }
    return 0;
  }
}
`

const ASKPASS_SH = `#!/bin/sh
printf '%s' "$DSH_VAULT_ASKPASS"
`

/** Where this plugin keeps helper binaries (falls back to the temp dir). */
function helperDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-credential-vault')
}

async function exists(path) {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    try {
      await access(path, fsConstants.F_OK)
      return true
    } catch {
      return false
    }
  }
}

function findCsc() {
  if (process.platform !== 'win32') return undefined
  const roots = [process.env.WINDIR ?? 'C:\\Windows', 'C:\\Windows']
  const frameworks = ['Framework64', 'Framework']
  for (const root of roots) {
    for (const framework of frameworks) {
      const candidate = join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

async function compileAskpass(target) {
  const csc = findCsc()
  if (csc === undefined) {
    throw new VaultError(
      'ssh-unsupported',
      '这台机器没有 .NET Framework 编译器（csc.exe），无法为密码登录生成 askpass 助手。请改用 SSH 密钥登录，或把公钥配置到服务器上。',
    )
  }
  const work = await mkdtemp(join(tmpdir(), 'dsh-vault-build-'))
  try {
    const source = join(work, 'askpass.cs')
    await writeFile(source, ASKPASS_CS, 'ascii')
    await mkdir(dirname(target), { recursive: true })
    const child = spawn(csc, ['/nologo', '/target:exe', `/out:${target}`, source], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString('utf8')
    })
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', (exit) => resolve(exit ?? -1))
    })
    if (code !== 0) {
      throw new VaultError('ssh-unsupported', `无法编译 SSH askpass 助手：${stderr.trim() || `csc 退出码 ${code}`}`)
    }
    return target
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

let askpassPromise

/** Resolve (and build once) the askpass helper used for password auth. */
export function ensureAskpass() {
  if (askpassPromise === undefined) {
    askpassPromise = (async () => {
      const dir = helperDir()
      if (process.platform === 'win32') {
        const target = join(dir, 'askpass.exe')
        if (await exists(target)) return target
        try {
          return await compileAskpass(target)
        } catch (error) {
          // A read-only DSH home still leaves the temp dir available.
          const fallback = join(tmpdir(), 'dsh-credential-vault', 'askpass.exe')
          if (await exists(fallback)) return fallback
          try {
            return await compileAskpass(fallback)
          } catch {
            throw error
          }
        }
      }
      const target = join(dir, 'askpass.sh')
      if (!(await exists(target))) {
        await mkdir(dir, { recursive: true })
        await writeFile(target, ASKPASS_SH, { mode: 0o700 })
        await chmod(target, 0o700).catch(() => {})
      }
      return target
    })().catch((error) => {
      askpassPromise = undefined
      throw error
    })
  }
  return askpassPromise
}

/** Run one command; resolves with capped output and never rejects on non-zero exit. */
function run(file, args, { env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let child
    try {
      child = spawn(file, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const out = []
    const err = []
    let outLength = 0
    let errLength = 0
    let truncated = false
    const take = (list, chunk, kind) => {
      const room = MAX_OUTPUT - (kind === 'out' ? outLength : errLength)
      if (room <= 0) {
        truncated = true
        return
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (slice.length < chunk.length) truncated = true
      list.push(slice)
      if (kind === 'out') outLength += slice.length
      else errLength += slice.length
    }
    child.stdout?.on('data', (chunk) => take(out, chunk, 'out'))
    child.stderr?.on('data', (chunk) => take(err, chunk, 'err'))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(1000, Math.min(30 * 60_000, timeoutMs)))
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code, spawnError) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        spawnError: spawnError === undefined ? undefined : String(spawnError.message ?? spawnError),
        durationMs: Date.now() - started,
      })
    }
    child.on('error', (error) => finish(-1, error))
    child.on('close', (code) => finish(code))
  })
}

/**
 * Build the OpenSSH invocation for one stored credential.
 *
 * Split from execution so the argument and environment contract can be tested
 * without a remote host: the result lists the exact argv, the askpass wiring
 * and the temporary key directory that must be removed afterwards.
 *
 * @param {object} entry - ssh entry from the vault.
 * @param {string} command - remote command line.
 * @param {object} options - `timeoutMs`, `askpass` path, `sshPath` override.
 * @returns {Promise<{file: string, args: string[], env: object, keyDir?: string, timeoutMs: number, target: string}>}
 */
export async function buildSshInvocation(entry, command, options = {}) {
  if (entry.type !== 'ssh') throw new VaultError('invalid', '该凭据不是 SSH 服务器凭据。')
  if (typeof command !== 'string' || command.trim() === '') throw new VaultError('invalid', '缺少要执行的命令。')
  const port = entry.port ?? 22
  const host = entry.host
  const user = entry.username
  const timeoutMs = options.timeoutMs ?? 60_000

  const args = [
    '-p', String(port),
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=20',
    '-o', 'LogLevel=ERROR',
  ]
  const env = { ...process.env }
  delete env[ASKPASS_VAR]
  let keyDir

  const hasKey = typeof entry.privateKey === 'string' && entry.privateKey.length > 0
  const hasPassword = typeof entry.password === 'string' && entry.password.length > 0
  // Pick whatever the stored record actually carries; `authMethod` orders the
  // choice when both exist, so a credential edited from key to password (or the
  // reverse) still works instead of failing on the stale preference.
  const useKey = hasKey && (entry.authMethod === 'key' || !hasPassword)

  if (useKey) {
    keyDir = await mkdtemp(join(tmpdir(), 'dsh-vault-key-'))
    const keyPath = join(keyDir, 'id_key')
    const keyText = entry.privateKey.endsWith('\n') ? entry.privateKey : `${entry.privateKey}\n`
    await writeFile(keyPath, keyText, { mode: 0o600 })
    await chmod(keyPath, 0o600).catch(() => {})
    args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes')
    if (typeof entry.passphrase === 'string' && entry.passphrase.length > 0) {
      env.SSH_ASKPASS = options.askpass ?? await ensureAskpass()
      env.SSH_ASKPASS_REQUIRE = 'force'
      env[ASKPASS_VAR] = entry.passphrase
      args.push('-o', 'NumberOfPasswordPrompts=0')
    } else {
      args.push('-o', 'BatchMode=yes')
    }
  } else {
    if (typeof entry.password !== 'string' || entry.password.length === 0) {
      throw new VaultError('invalid', '该 SSH 凭据没有可用的密码或私钥。')
    }
    env.SSH_ASKPASS = options.askpass ?? await ensureAskpass()
    env.SSH_ASKPASS_REQUIRE = 'force'
    env[ASKPASS_VAR] = entry.password
    if (process.platform === 'win32') env.DISPLAY = env.DISPLAY ?? ':0'
    args.push(
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'PubkeyAuthentication=no',
    )
  }

  args.push(`${user}@${host}`, command)

  return {
    file: options.sshPath ?? process.env.DSH_SSH_PATH ?? 'ssh',
    args,
    env,
    keyDir,
    timeoutMs,
    target: `${user}@${host}:${port}`,
  }
}

/**
 * Execute a command over SSH using one stored server credential.
 * @param {object} entry - ssh entry from the vault.
 * @param {string} command - remote command line.
 * @param {object} options - timeout, abort signal, askpass/ssh path overrides.
 * @returns {Promise<object>} exit status, stdout/stderr and metadata.
 */
export async function runSshCommand(entry, command, options = {}) {
  const invocation = await buildSshInvocation(entry, command, options)
  const timeoutMs = invocation.timeoutMs ?? 60_000
  try {
    const result = await run(invocation.file, invocation.args, {
      env: invocation.env,
      timeoutMs,
      signal: options.signal,
    })
    if (result.spawnError !== undefined && /ENOENT/u.test(result.spawnError)) {
      throw new VaultError('ssh-missing', '找不到 ssh 客户端。请安装 Windows OpenSSH 客户端后重试。')
    }
    if (result.timedOut) {
      throw new VaultError('ssh-timeout', `命令在 ${Math.round(timeoutMs / 1000)} 秒后超时并被终止。`)
    }
    return {
      ok: result.code === 0,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      durationMs: result.durationMs,
      target: invocation.target,
    }
  } finally {
    if (invocation.keyDir !== undefined) {
      await rm(invocation.keyDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
