/**
 * Agent tools for `dsh-credential-vault`.
 *
 * Four tools share the vault service: `credential_list`, `credential_get`,
 * `credential_save` and `ssh_exec`. The definitions are plain registry objects
 * (the same shape `defineTool` produces) so this package needs no build step
 * and no runtime dependency on a Harness package.
 *
 * @module dsh-credential-vault/tools
 */
import { runSshCommand } from './ssh.js'
import { VaultError } from './vault.js'

const JSON_RENDER = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function forbidden(message) {
  throw new VaultError('forbidden', message)
}

function errorText(error) {
  if (error instanceof VaultError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register every credential tool on the plugin context.
 * @param {object} ctx - Host plugin context with `tools`.
 * @param {import('./vault.js').Vault} vault - vault service.
 * @param {object} settings - resolved plugin config.
 */
export function registerTools(ctx, vault, settings) {
  ctx.tools.register({
    name: 'credential_list',
    description:
      '列出凭据管家（credential-vault）中保存的凭据，只返回名称、类型、用途备注和地址/账号等元数据，绝不返回密码或令牌。支持按类型或关键词过滤。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['web', 'github', 'ssh'], description: '只看某一类型：web=网页系统，github=GitHub，ssh=服务器。' },
        query: { type: 'string', description: '按名称、备注、网址、主机或账号做不区分大小写的模糊过滤。' },
      },
    },
    output: { schema: {}, render: JSON_RENDER },
    async execute(args = {}) {
      let entries = await vault.list()
      if (typeof args.type === 'string' && args.type !== '') {
        entries = entries.filter((entry) => entry.type === args.type)
      }
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        const needle = args.query.trim().toLowerCase()
        entries = entries.filter((entry) =>
          [entry.name, entry.note, entry.url, entry.host, entry.username]
            .filter((value) => typeof value === 'string')
            .some((value) => value.toLowerCase().includes(needle)),
        )
      }
      return {
        count: entries.length,
        entries,
        hint: '需要明文时调用 credential_get 并传 reveal=true；SSH 服务器优先用 ssh_exec 执行命令。',
      }
    },
  })

  ctx.tools.register({
    name: 'credential_get',
    description:
      '读取一条凭据的完整内容。默认把密码/令牌/私钥替换为掩码，只有显式传 reveal=true 才返回明文（明文会写入本次会话记录）。id 来自 credential_list。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '凭据 id，例如 web-1a2b3c4d5e6f。' },
        reveal: { type: 'boolean', description: 'true 时返回密码/令牌/私钥明文；默认 false。' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: JSON_RENDER },
    async execute(args = {}) {
      if (typeof args.id !== 'string' || args.id === '') throw new VaultError('invalid', '缺少凭据 id。')
      if (args.reveal === true) {
        if (settings.allowAgentReveal === false) forbidden('当前配置不允许向 agent 返回凭据明文（allowAgentReveal: false）。')
        return vault.revealEntry(args.id)
      }
      return vault.describe(args.id)
    },
  })

  ctx.tools.register({
    name: 'credential_save',
    description:
      '新建或更新一条凭据。不传 id 表示新建；传 id 表示更新（未提供的字段保持不变）。' +
      '字段：web 需要 name/url/username/password；github 需要 name/username/token（可选 email）；' +
      'ssh 需要 name/host/username 与 password 或 privateKey（可选 port、passphrase、authMethod=password|key）。' +
      'note 用来记录这条凭据的用途。密钥字段传 null 表示清除，留空表示保持原值。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '更新已有凭据时提供；新建时省略。' },
        type: { type: 'string', enum: ['web', 'github', 'ssh'], description: '凭据类型；更新时可省略。' },
        name: { type: 'string', description: '凭据名称，例如「公司 OA」。' },
        note: { type: 'string', description: '用途备注，例如「内网报销系统，仅内网可访问」。' },
        url: { type: 'string', description: 'web：登录网址。' },
        username: { type: 'string', description: 'web/github/ssh：账号或登录用户。' },
        password: { type: 'string', description: 'web/ssh：密码明文。' },
        token: { type: 'string', description: 'github：Personal Access Token。' },
        email: { type: 'string', description: 'github：git 提交邮箱（可选）。' },
        host: { type: 'string', description: 'ssh：主机名或 IP。' },
        port: { type: 'number', description: 'ssh：端口，默认 22。' },
        authMethod: { type: 'string', enum: ['password', 'key'], description: 'ssh：认证方式，默认按是否提供私钥推断。' },
        privateKey: { type: 'string', description: 'ssh：OpenSSH/PEM 私钥全文。' },
        passphrase: { type: 'string', description: 'ssh：私钥口令（可选）。' },
      },
    },
    output: { schema: {}, render: JSON_RENDER },
    async execute(args = {}) {
      if (settings.allowAgentWrite === false) forbidden('当前配置不允许 agent 写入凭据（allowAgentWrite: false）。')
      const saved = await vault.save(args)
      return { saved, hint: '已保存。凭据明文不会出现在列表里，需要时用 credential_get 读取。' }
    },
  })

  ctx.tools.register({
    name: 'ssh_exec',
    description:
      '使用凭据管家中保存的 SSH 服务器凭据在远程主机执行一条命令，密码/私钥不会出现在命令行或工具参数里。返回退出码、stdout 和 stderr。适合部署、查看日志、重启服务等操作；需要交互式会话时改用终端工具。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'SSH 凭据 id（来自 credential_list，type=ssh）。' },
        command: { type: 'string', description: '在远程主机上执行的命令，例如 "systemctl status nginx"。' },
        timeoutMs: { type: 'number', description: '超时时间（毫秒），默认取插件配置，通常 60000。' },
      },
      required: ['id', 'command'],
    },
    output: {
      schema: {},
      render: (_args, value) => {
        const parts = [`$ ${value.target ?? ''}`, `exit ${value.exitCode} (${value.durationMs} ms)`]
        if (value.stdout) parts.push(value.stdout)
        if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
        if (value.truncated) parts.push('（输出过长，已截断。）')
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args = {}, exec) {
      if (typeof args.id !== 'string' || args.id === '') throw new VaultError('invalid', '缺少 SSH 凭据 id。')
      if (typeof args.command !== 'string' || args.command.trim() === '') throw new VaultError('invalid', '缺少要执行的命令。')
      const entry = await vault.readRaw(args.id)
      if (entry.type !== 'ssh') throw new VaultError('invalid', '只能对 SSH 类型的凭据执行 ssh_exec。')
      const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : settings.sshTimeoutMs
      try {
        return await runSshCommand(entry, args.command, { timeoutMs, signal: exec?.signal })
      } catch (error) {
        if (error instanceof VaultError) throw error
        throw new VaultError('ssh-failed', errorText(error))
      }
    },
  })
}
