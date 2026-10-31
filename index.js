/**
 * dsh-credential-vault — Host half.
 *
 * One credential vault for the whole profile: web logins, GitHub tokens and
 * SSH servers, addressed by id and stored as records in the Harness credential
 * store. The browser half (./client) renders the Settings section; this half
 * owns persistence, the agent tools and the Browser ⇄ Host route.
 *
 * @module dsh-credential-vault
 */
import { registerRpc } from './src/rpc.js'
import { registerTools } from './src/tools.js'
import { Vault } from './src/vault.js'

/** Registered plugin name; also the credential record scope. */
export const name = 'credential-vault'

/** Services this plugin needs from the Host composition. */
export const inject = ['tools', 'credentials', 'systemPrompt']

/**
 * Normalize user config without a Schemastery dependency so the bundle needs
 * no build step.
 * @param {object|undefined} config - the row config from cordis.patch.yml.
 * @returns {object} resolved settings.
 */
function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const number = (value, fallback) => (Number.isFinite(value) ? value : fallback)
  return {
    promptSummary: source.promptSummary !== false,
    maxPromptEntries: Math.max(1, Math.min(50, number(source.maxPromptEntries, 12))),
    allowAgentReveal: source.allowAgentReveal !== false,
    allowAgentWrite: source.allowAgentWrite !== false,
    sshTimeoutMs: Math.max(5000, Math.min(30 * 60_000, number(source.sshTimeoutMs, 60_000))),
  }
}

/**
 * Mount the vault: storage projection, tools, Settings route and prompt section.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - bundle row config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const vault = new Vault(ctx, settings)

  registerTools(ctx, vault, settings)

  // The Settings page is optional: headless and terminal profiles have no
  // Connection/Web server, and the tools above still work there.
  ctx.inject(['connection', 'webServer'], (web) => {
    registerRpc(web, vault, settings)
  })

  if (settings.promptSummary) {
    vault.prime()
    ctx.systemPrompt.section({
      name: 'credential-vault',
      order: 60,
      text: () => vault.promptSection(),
    })
  }

  ctx.logger?.info?.('credential-vault: ready')
}
