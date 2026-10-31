/**
 * dsh-credential-vault — Web Client half.
 *
 * Registers a "凭据管家" section in the Harness Settings panel. Every read and
 * write goes through the Host RPC channel `/credential-vault`; secrets reach
 * this page only when the user explicitly clicks 显示 for one entry.
 *
 * Loaded by the Harness module loader as `dsh-credential-vault`; React comes
 * from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-credential-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CHANNEL = '/credential-vault'

    const TYPE_META = {
      web: { label: '网页系统', hint: '登录网址、账户与密码', color: '#3b82f6' },
      github: { label: 'GitHub', hint: '用户名与访问令牌，用于仓库操作', color: '#8b5cf6' },
      ssh: { label: 'SSH 服务器', hint: '主机、登录用户与密码或私钥', color: '#10b981' },
    }
    const TYPE_ORDER = ['web', 'github', 'ssh']

    const STYLES = String.raw`
.dcv-page {
  width: 100%;
  max-width: 880px;
  padding: 8px 0 32px;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 13px;
  line-height: 20px;
}
.dcv-page *, .dcv-page *::before, .dcv-page *::after { box-sizing: border-box; }
.dcv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
.dcv-headText h2 { margin: 0 0 4px; font-size: 17px; line-height: 24px; font-weight: 650; }
.dcv-headText p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; line-height: 19px; max-width: 560px; }
.dcv-headActions { display: flex; align-items: center; gap: 8px; }
.dcv-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 550;
  cursor: pointer; white-space: nowrap; transition: background .15s ease, border-color .15s ease, opacity .15s ease;
}
.dcv-btn:disabled { opacity: .5; cursor: not-allowed; }
.dcv-btnPrimary { background: var(--dsw-alias-state-business-primary, #3370ff); border-color: var(--dsw-alias-state-business-primary, #3370ff); color: #fff; }
.dcv-btnPrimary:hover:not(:disabled) { filter: brightness(.95); }
.dcv-btnSoft { border-color: var(--dsw-alias-border-l2, #dfe1e5); background: var(--dsw-alias-bg-layer-1, #fff); }
.dcv-btnSoft:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f5f6f7); }
.dcv-btnGhost { color: var(--dsw-alias-label-secondary, #646a73); }
.dcv-btnGhost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f5f6f7); }
.dcv-btnDanger { color: #d4380d; border-color: color-mix(in srgb, #f54a45 35%, transparent); background: transparent; }
.dcv-btnDanger:hover:not(:disabled) { background: color-mix(in srgb, #f54a45 8%, transparent); }
.dcv-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 14px; }
.dcv-search { position: relative; flex: 1 1 240px; min-width: 180px; }
.dcv-search input {
  width: 100%; min-height: 34px; padding: 0 12px 0 32px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit; font: inherit; font-size: 13px; outline: none;
}
.dcv-search input:focus { border-color: var(--dsw-alias-state-business-primary, #3370ff); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 16%, transparent); }
.dcv-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--dsw-alias-label-tertiary, #8f959e); }
.dcv-tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f2f3f5); }
.dcv-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #646a73); font: inherit; font-size: 12.5px; font-weight: 550; padding: 4px 10px; border-radius: 7px; cursor: pointer; }
.dcv-tab[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); box-shadow: 0 1px 2px rgb(31 35 41 / 8%); }
.dcv-list { display: flex; flex-direction: column; gap: 10px; }
.dcv-card {
  border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff); padding: 14px 16px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dcv-card:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 28%, var(--dsw-alias-border-l2, #e5e6eb)); box-shadow: 0 2px 10px rgb(31 35 41 / 4%); }
.dcv-cardTop { display: flex; align-items: flex-start; gap: 12px; }
.dcv-icon { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; }
.dcv-icon[data-type='web'] { background: color-mix(in srgb, #3b82f6 12%, transparent); color: #2563eb; }
.dcv-icon[data-type='github'] { background: color-mix(in srgb, #8b5cf6 12%, transparent); color: #7c3aed; }
.dcv-icon[data-type='ssh'] { background: color-mix(in srgb, #10b981 12%, transparent); color: #059669; }
.dcv-cardHead { flex: 1; min-width: 0; }
.dcv-titleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dcv-name { font-size: 14px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.dcv-badge { flex: none; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, #f2f3f5); color: var(--dsw-alias-label-secondary, #646a73); }
.dcv-target { margin-top: 2px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; word-break: break-all; }
.dcv-cardActions { display: flex; align-items: center; gap: 4px; flex: none; }
.dcv-note { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #fafbfc); color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; line-height: 19px; white-space: pre-wrap; word-break: break-word; }
.dcv-secrets { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.dcv-secretRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dcv-secretLabel { flex: none; min-width: 52px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.dcv-secretValue {
  flex: 1 1 200px; min-width: 0; padding: 3px 8px; border-radius: 6px;
  border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dcv-secretValue[data-revealed='true'] { border-style: solid; color: var(--dsw-alias-label-primary, #1f2329); white-space: pre-wrap; word-break: break-all; }
.dcv-pre { margin: 8px 0 0; padding: 10px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform, #f2f3f5); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 17px; max-height: 220px; overflow: auto; white-space: pre; }
.dcv-empty { padding: 40px 20px; text-align: center; border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5); border-radius: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dcv-empty strong { display: block; color: var(--dsw-alias-label-secondary, #646a73); font-size: 14px; margin-bottom: 4px; }
.dcv-editor { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 32%, var(--dsw-alias-border-l2, #e5e6eb)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 18px rgb(31 35 41 / 6%); }
.dcv-editorHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.dcv-editorHead h3 { margin: 0; font-size: 14px; font-weight: 640; }
.dcv-close { border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 18px; line-height: 1; width: 26px; height: 26px; border-radius: 6px; cursor: pointer; }
.dcv-close:hover { background: var(--dsw-alias-interactive-bg-hover, #f5f6f7); color: var(--dsw-alias-label-primary, #1f2329); }
.dcv-typeGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
.dcv-typeCard { text-align: left; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; cursor: pointer; }
.dcv-typeCard[aria-pressed='true'] { border-color: var(--dsw-alias-state-business-primary, #3370ff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 7%, transparent); }
.dcv-typeCard b { display: block; font-size: 13px; font-weight: 600; }
.dcv-typeCard span { display: block; margin-top: 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dcv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.dcv-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dcv-field > span { font-size: 12.5px; font-weight: 560; color: var(--dsw-alias-label-secondary, #646a73); }
.dcv-field input, .dcv-field textarea, .dcv-field select {
  width: 100%; min-height: 34px; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit; font: inherit; font-size: 13px; outline: none;
}
.dcv-field textarea { min-height: 68px; resize: vertical; line-height: 19px; }
.dcv-field input:focus, .dcv-field textarea:focus, .dcv-field select:focus { border-color: var(--dsw-alias-state-business-primary, #3370ff); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 16%, transparent); }
.dcv-fieldWide { grid-column: 1 / -1; }
.dcv-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dcv-hintWarn { color: #b25c00; }
.dcv-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform, #f2f3f5); }
.dcv-seg button { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #646a73); font: inherit; font-size: 12.5px; padding: 4px 12px; border-radius: 6px; cursor: pointer; }
.dcv-seg button[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); box-shadow: 0 1px 2px rgb(31 35 41 / 8%); }
.dcv-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.dcv-msg { margin-top: 12px; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; line-height: 19px; }
.dcv-msgError { background: color-mix(in srgb, #f54a45 8%, transparent); border: 1px solid color-mix(in srgb, #f54a45 26%, transparent); color: #b42318; }
.dcv-msgOk { background: color-mix(in srgb, #10b981 10%, transparent); border: 1px solid color-mix(in srgb, #10b981 26%, transparent); color: #067647; }
.dcv-busy { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.dcv-skel { height: 88px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, #fafbfc); border: 1px solid var(--dsw-alias-border-l2, #eef0f3); animation: dcvPulse 1.4s ease-in-out infinite; }
@keyframes dcvPulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .dcv-skel { animation: none; } }
@media (max-width: 560px) { .dcv-typeGrid { grid-template-columns: 1fr; } .dcv-cardTop { flex-wrap: wrap; } }
`

    let styleInstalled = false
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById('dsh-credential-vault-styles')
      if (existing !== null || styleInstalled) return () => {}
      const tag = document.createElement('style')
      tag.id = 'dsh-credential-vault-styles'
      tag.textContent = STYLES
      document.head.appendChild(tag)
      styleInstalled = true
      return () => {
        tag.remove()
        styleInstalled = false
      }
    }

    function callRpc(endpoint, payload) {
      return fetch(`${CHANNEL}/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
      }).then(async (response) => {
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok) {
          const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`
          throw new Error(message)
        }
        if (!body || body.ok !== true) {
          const error = body && body.error ? body.error : {}
          throw new Error(error.message || `请求 /credential-vault/${endpoint} 失败`)
        }
        return body.value
      })
    }

    function typeLabel(type) {
      return (TYPE_META[type] && TYPE_META[type].label) || type
    }

    function targetOf(entry) {
      if (entry.type === 'web') return entry.url || ''
      if (entry.type === 'github') return entry.username ? `github.com/${entry.username}` : 'github.com'
      return `${entry.username || '?'}@${entry.host || '?'}:${entry.port || 22}`
    }

    async function copyText(value) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value)
        return
      }
      const area = document.createElement('textarea')
      area.value = value
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try {
        document.execCommand('copy')
      } finally {
        area.remove()
      }
    }

    function Icon({ type, size }) {
      const common = { width: size || 18, height: size || 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
      if (type === 'ssh') {
        return h('svg', common,
          h('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 3 }),
          h('path', { d: 'M6.5 9.5 9.5 12l-3 2.5' }),
          h('path', { d: 'M11.5 15h5' }))
      }
      if (type === 'github') {
        return h('svg', common,
          h('path', { d: 'M9 19c-4.3 1.3-4.3-2.5-6-3m12 5v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.1-1.5 6.1-6.7a5.2 5.2 0 0 0-1.4-3.6 4.9 4.9 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.5 12.5 0 0 0-6.6 0C5.8 1.3 4.7 1.6 4.7 1.6a4.9 4.9 0 0 0-.1 3.6A5.2 5.2 0 0 0 3.2 8.9c0 5.1 3.1 6.3 6.1 6.7a3.4 3.4 0 0 0-.9 2.6V21' }))
      }
      return h('svg', common,
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18' }),
        h('path', { d: 'M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18Z' }))
    }

    function Field({ label, hint, wide, children }) {
      return h('label', { className: `dcv-field${wide ? ' dcv-fieldWide' : ''}` },
        h('span', null, label),
        children,
        hint ? h('span', { className: 'dcv-hint' }, hint) : null)
    }

    function SecretInput({ label, value, existing, placeholder, onChange, onClear, multiline }) {
      const tag = multiline ? 'textarea' : 'input'
      const props = {
        value: value === null ? '' : (value || ''),
        placeholder: value === null ? '保存后会被清除' : (existing ? '已保存，留空则保持不变' : placeholder),
        onChange: (event) => onChange(event.target.value),
        autoComplete: 'new-password',
        spellCheck: false,
      }
      if (multiline) props.rows = 5
      return h(Field, { label, wide: multiline, hint: existing && value !== null ? '已保存；留空保持不变，点右侧「清除」可删除。' : null },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
          h(tag, { className: 'dcv-secretInput', ...props, style: { flex: 1 } }),
          existing ? h('button', {
            type: 'button',
            className: 'dcv-btn dcv-btnSoft',
            style: { minHeight: multiline ? 34 : 34 },
            onClick: onClear,
          }, value === null ? '撤销清除' : '清除') : null))
    }

    function emptyDraft(type) {
      return {
        id: '',
        type: type || 'web',
        name: '',
        note: '',
        url: '',
        username: '',
        password: '',
        token: '',
        email: '',
        host: '',
        port: 22,
        authMethod: 'password',
        privateKey: '',
        passphrase: '',
        existing: {},
        error: null,
      }
    }

    function draftFromEntry(entry, revealed) {
      return {
        id: entry.id,
        type: entry.type,
        name: entry.name || '',
        note: entry.note || '',
        url: entry.url || '',
        username: entry.username || '',
        password: revealed && revealed.password ? revealed.password : '',
        token: revealed && revealed.token ? revealed.token : '',
        email: entry.email || '',
        host: entry.host || '',
        port: entry.port || 22,
        authMethod: entry.authMethod || 'password',
        privateKey: '',
        passphrase: '',
        existing: {
          password: entry.hasPassword === true && !(revealed && revealed.password),
          token: entry.hasToken === true && !(revealed && revealed.token),
          privateKey: entry.hasPrivateKey === true,
          passphrase: entry.hasPassphrase === true,
        },
        error: null,
      }
    }

    function Editor({ draft, busy, onChange, onCancel, onSave }) {
      const set = (patch) => onChange({ ...draft, ...patch, error: null })
      const type = draft.type
      const isEdit = Boolean(draft.id)
      const canClear = (field) => draft.existing[field] === true
      const secretValue = (field) => (draft[field] === null ? null : draft[field])
      const toggleClear = (field) => set({ [field]: draft[field] === null ? '' : null })
      const secretInput = (field, label, placeholder, multiline) => h(SecretInput, {
        label,
        value: secretValue(field),
        existing: canClear(field),
        placeholder,
        multiline,
        onChange: (value) => set({ [field]: value }),
        onClear: () => toggleClear(field),
      })

      return h('div', { className: 'dcv-editor' },
        h('div', { className: 'dcv-editorHead' },
          h('h3', null, isEdit ? `编辑凭据 · ${typeLabel(type)}` : '新增凭据'),
          h('button', { type: 'button', className: 'dcv-close', onClick: onCancel, 'aria-label': '关闭' }, '×')),
        !isEdit ? h('div', { className: 'dcv-typeGrid', role: 'group', 'aria-label': '凭据类型' },
          TYPE_ORDER.map((key) => h('button', {
            key,
            type: 'button',
            className: 'dcv-typeCard',
            'aria-pressed': draft.type === key,
            onClick: () => set({ type: key }),
          },
          h('b', null, TYPE_META[key].label),
          h('span', null, TYPE_META[key].hint)))) : null,
        h('div', { className: 'dcv-grid' },
          h(Field, { label: '名称' },
            h('input', {
              autoFocus: true,
              value: draft.name,
              placeholder: type === 'web' ? '例如：公司 OA' : type === 'github' ? '例如：个人 GitHub' : '例如：生产服务器 A',
              onChange: (event) => set({ name: event.target.value }),
            })),
          type === 'web' ? h(Field, { label: '登录网址' },
            h('input', {
              value: draft.url,
              placeholder: 'https://oa.example.com/login',
              spellCheck: false,
              onChange: (event) => set({ url: event.target.value }),
            })) : null,
          type === 'github' ? h(Field, { label: 'GitHub 用户名' },
            h('input', {
              value: draft.username,
              placeholder: 'octocat',
              spellCheck: false,
              onChange: (event) => set({ username: event.target.value }),
            })) : null,
          type === 'ssh' ? h(Field, { label: '主机地址' },
            h('input', {
              value: draft.host,
              placeholder: '10.0.0.5 或 server.example.com',
              spellCheck: false,
              onChange: (event) => set({ host: event.target.value }),
            })) : null,
          type === 'ssh' ? h(Field, { label: '端口' },
            h('input', {
              type: 'number',
              min: 1,
              max: 65535,
              value: draft.port,
              onChange: (event) => set({ port: event.target.value === '' ? '' : Number(event.target.value) }),
            })) : null,
          type === 'web' ? h(Field, { label: '账户' },
            h('input', {
              value: draft.username,
              placeholder: '登录账号',
              autoComplete: 'off',
              onChange: (event) => set({ username: event.target.value }),
            })) : null,
          type === 'ssh' ? h(Field, { label: '登录用户' },
            h('input', {
              value: draft.username,
              placeholder: 'root',
              autoComplete: 'off',
              onChange: (event) => set({ username: event.target.value }),
            })) : null,
          type === 'web' ? secretInput('password', '密码', '登录密码') : null,
          type === 'github' ? secretInput('token', 'Personal Access Token', 'ghp_… 或 github_pat_…') : null,
          type === 'github' ? h(Field, { label: '提交邮箱（可选）', hint: '用于 git 提交的 user.email。' },
            h('input', {
              value: draft.email,
              placeholder: 'you@example.com',
              spellCheck: false,
              onChange: (event) => set({ email: event.target.value }),
            })) : null,
          type === 'ssh' ? h(Field, { label: '认证方式' },
            h('div', { className: 'dcv-seg' },
              h('button', { type: 'button', 'aria-pressed': (draft.authMethod || 'password') === 'password', onClick: () => set({ authMethod: 'password' }) }, '密码'),
              h('button', { type: 'button', 'aria-pressed': draft.authMethod === 'key', onClick: () => set({ authMethod: 'key' }) }, '密钥'))) : null,
          type === 'ssh' && (draft.authMethod || 'password') === 'password' ? secretInput('password', '密码', 'SSH 登录密码') : null,
          type === 'ssh' && draft.authMethod === 'key' ? secretInput('privateKey', '私钥', '-----BEGIN OPENSSH PRIVATE KEY-----', true) : null,
          type === 'ssh' && draft.authMethod === 'key' ? secretInput('passphrase', '私钥口令（可选）', '私钥如果没有口令就留空') : null,
          h(Field, { label: '备注（这条凭据用来做什么）', wide: true, hint: '会展示在列表里，也会出现在后续会话的凭据概览中。' },
            h('textarea', {
              value: draft.note,
              rows: 3,
              placeholder: type === 'web' ? '例如：内网报销系统，每月报账用' : type === 'github' ? '例如：个人仓库管理，用于 clone / push' : '例如：生产环境部署机，systemctl 重启服务用',
              onChange: (event) => set({ note: event.target.value }),
            }))),
        draft.error ? h('div', { className: 'dcv-msg dcv-msgError' }, draft.error) : null,
        h('div', { className: 'dcv-actions' },
          h('button', { type: 'button', className: 'dcv-btn dcv-btnPrimary', disabled: busy === true, onClick: () => onSave(draft) }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', className: 'dcv-btn dcv-btnSoft', disabled: busy === true, onClick: onCancel }, '取消'),
          busy ? h('span', { className: 'dcv-busy' }, '正在写入 Host 凭据存储…') : null))
    }

    function SecretRow({ label, entry, field, revealed, onReveal, onHide, onCopy, multiline }) {
      const value = revealed ? revealed : null
      const placeholder = multiline ? '（已保存私钥）' : '••••••••'
      return h(React.Fragment, null,
        h('div', { className: 'dcv-secretRow' },
          h('span', { className: 'dcv-secretLabel' }, label),
          h('code', { className: 'dcv-secretValue', 'data-revealed': !multiline && value !== null }, value !== null && !multiline ? value : placeholder),
          value === null
            ? h('button', { type: 'button', className: 'dcv-btn dcv-btnSoft', onClick: () => onReveal(entry, field) }, multiline ? '查看' : '显示')
            : h('button', { type: 'button', className: 'dcv-btn dcv-btnSoft', onClick: () => onHide(entry, field) }, '隐藏'),
          value !== null ? h('button', { type: 'button', className: 'dcv-btn dcv-btnSoft', onClick: () => onCopy(value) }, '复制') : null),
        multiline && value !== null ? h('pre', { className: 'dcv-pre' }, value) : null)
    }

    function EntryCard({ entry, revealed, busy, confirming, onReveal, onHide, onCopy, onEdit, onDelete }) {
      const secrets = []
      if (entry.type === 'web' && entry.hasPassword) {
        secrets.push(h(SecretRow, { key: 'password', label: '密码', entry, field: 'password', revealed: revealed.password, onReveal, onHide, onCopy }))
      }
      if (entry.type === 'github' && entry.hasToken) {
        secrets.push(h(SecretRow, { key: 'token', label: '令牌', entry, field: 'token', revealed: revealed.token, onReveal, onHide, onCopy }))
      }
      if (entry.type === 'ssh' && entry.hasPassword) {
        secrets.push(h(SecretRow, { key: 'password', label: '密码', entry, field: 'password', revealed: revealed.password, onReveal, onHide, onCopy }))
      }
      if (entry.type === 'ssh' && entry.hasPrivateKey) {
        secrets.push(h(SecretRow, { key: 'privateKey', label: '私钥', entry, field: 'privateKey', revealed: revealed.privateKey, onReveal, onHide, onCopy, multiline: true }))
      }
      if (entry.type === 'ssh' && entry.hasPassphrase) {
        secrets.push(h(SecretRow, { key: 'passphrase', label: '口令', entry, field: 'passphrase', revealed: revealed.passphrase, onReveal, onHide, onCopy }))
      }
      const isBusy = busy === entry.id
      return h('article', { className: 'dcv-card' },
        h('div', { className: 'dcv-cardTop' },
          h('span', { className: 'dcv-icon', 'data-type': entry.type }, h(Icon, { type: entry.type })),
          h('div', { className: 'dcv-cardHead' },
            h('div', { className: 'dcv-titleRow' },
              h('span', { className: 'dcv-name', title: entry.name }, entry.name),
              h('span', { className: 'dcv-badge' }, typeLabel(entry.type)),
              entry.type === 'ssh' ? h('span', { className: 'dcv-badge' }, entry.authMethod === 'key' ? '密钥登录' : '密码登录') : null),
            h('div', { className: 'dcv-target' }, targetOf(entry))),
          h('div', { className: 'dcv-cardActions' },
            h('button', { type: 'button', className: 'dcv-btn dcv-btnGhost', onClick: () => onCopy(entry.username || '') , disabled: !entry.username, title: '复制账号' }, '复制账号'),
            h('button', { type: 'button', className: 'dcv-btn dcv-btnSoft', onClick: () => onEdit(entry) }, '编辑'),
            h('button', {
              type: 'button',
              className: 'dcv-btn dcv-btnDanger',
              disabled: isBusy,
              onClick: () => onDelete(entry),
            }, confirming ? '确认删除？' : (isBusy ? '删除中…' : '删除')))),
        entry.note ? h('p', { className: 'dcv-note' }, entry.note) : null,
        secrets.length > 0 ? h('div', { className: 'dcv-secrets' }, secrets) : null)
    }

    function VaultSection() {
      const [loaded, setLoaded] = React.useState(false)
      const [entries, setEntries] = React.useState([])
      const [loadError, setLoadError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [editor, setEditor] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [busyId, setBusyId] = React.useState(null)
      const [confirmId, setConfirmId] = React.useState(null)
      const [revealed, setRevealed] = React.useState({})

      const flash = React.useCallback((kind, text) => {
        setNotice({ kind, text })
        window.setTimeout(() => {
          setNotice((current) => (current && current.text === text ? null : current))
        }, 4000)
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const value = await callRpc('list', {})
          setEntries(Array.isArray(value.entries) ? value.entries : [])
          setLoadError(null)
        } catch (error) {
          setLoadError(error.message || String(error))
        } finally {
          setLoaded(true)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      React.useEffect(() => {
        if (confirmId === null) return undefined
        const timer = window.setTimeout(() => setConfirmId(null), 4000)
        return () => window.clearTimeout(timer)
      }, [confirmId])

      const save = async (draft) => {
        setSaving(true)
        const payload = { ...draft }
        delete payload.error
        delete payload.existing
        if (!payload.id) delete payload.id
        if (typeof payload.port === 'string') payload.port = payload.port === '' ? undefined : Number(payload.port)
        try {
          await callRpc('save', payload)
          setEditor(null)
          setRevealed({})
          flash('ok', '已保存到 Host 凭据存储，后续会话可直接使用。')
          await refresh()
        } catch (error) {
          setEditor((current) => (current ? { ...current, error: error.message || String(error) } : current))
        } finally {
          setSaving(false)
        }
      }

      const remove = async (entry) => {
        if (confirmId !== entry.id) {
          setConfirmId(entry.id)
          return
        }
        setConfirmId(null)
        setBusyId(entry.id)
        try {
          await callRpc('remove', { id: entry.id })
          setRevealed((current) => {
            const next = { ...current }
            delete next[entry.id]
            return next
          })
          flash('ok', `已删除「${entry.name}」。`)
          await refresh()
        } catch (error) {
          flash('error', error.message || String(error))
        } finally {
          setBusyId(null)
        }
      }

      const reveal = async (entry, field) => {
        try {
          const value = await callRpc('reveal', { id: entry.id, field })
          setRevealed((current) => ({ ...current, [entry.id]: { ...(current[entry.id] || {}), [field]: value.value } }))
        } catch (error) {
          flash('error', error.message || String(error))
        }
      }

      const hide = (entry, field) => {
        setRevealed((current) => {
          const next = { ...current }
          const values = { ...(next[entry.id] || {}) }
          delete values[field]
          if (Object.keys(values).length === 0) delete next[entry.id]
          else next[entry.id] = values
          return next
        })
      }

      const copy = async (value) => {
        if (!value) return
        try {
          await copyText(value)
          flash('ok', '已复制到剪贴板。')
        } catch (error) {
          flash('error', '复制失败：' + (error.message || String(error)))
        }
      }

      const counts = { all: entries.length, web: 0, github: 0, ssh: 0 }
      for (const entry of entries) counts[entry.type] = (counts[entry.type] || 0) + 1
      const needle = query.trim().toLowerCase()
      const visible = entries.filter((entry) => {
        if (filter !== 'all' && entry.type !== filter) return false
        if (needle === '') return true
        return [entry.name, entry.note, entry.url, entry.host, entry.username]
          .filter((value) => typeof value === 'string')
          .some((value) => value.toLowerCase().includes(needle))
      })

      return h('section', { className: 'dcv-page', 'aria-label': '凭据管家' },
        h('div', { className: 'dcv-head' },
          h('div', { className: 'dcv-headText' },
            h('h2', null, '凭据管家'),
            h('p', null, '集中保存网页系统、GitHub 与 SSH 服务器的登录凭据，并备注用途。保存后，当前及后续会话都能通过 credential_list / credential_get 读取，SSH 服务器还可以用 ssh_exec 直接执行命令。明文只保存在本机 Host 的凭据存储里，列表与提示词中只有元数据。')),
          h('div', { className: 'dcv-headActions' },
            h('button', {
              type: 'button',
              className: 'dcv-btn dcv-btnPrimary',
              onClick: () => {
                setEditor(emptyDraft(filter === 'all' ? 'web' : filter))
                setNotice(null)
              },
            }, '新增凭据'))),
        loadError ? h('div', { className: 'dcv-msg dcv-msgError' },
          `无法读取凭据：${loadError}`,
          h('button', { type: 'button', className: 'dcv-btn dcv-btnSoft', style: { marginLeft: 10 }, onClick: () => void refresh() }, '重试')) : null,
        editor ? h(Editor, {
          draft: editor,
          busy: saving,
          onChange: setEditor,
          onCancel: () => setEditor(null),
          onSave: save,
        }) : null,
        h('div', { className: 'dcv-toolbar' },
          h('div', { className: 'dcv-search' },
            h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
              h('circle', { cx: 11, cy: 11, r: 7 }),
              h('path', { d: 'm20 20-3.5-3.5' })),
            h('input', {
              value: query,
              placeholder: '搜索名称、备注、网址、主机或账号',
              'aria-label': '搜索凭据',
              onChange: (event) => setQuery(event.target.value),
            })),
          h('div', { className: 'dcv-tabs', role: 'group', 'aria-label': '按类型筛选' },
            [['all', '全部'], ['web', '网页'], ['github', 'GitHub'], ['ssh', 'SSH']].map(([key, label]) =>
              h('button', {
                key,
                type: 'button',
                className: 'dcv-tab',
                'aria-pressed': filter === key,
                onClick: () => setFilter(key),
              }, `${label} ${counts[key] || 0}`)))),
        !loaded
          ? h('div', { className: 'dcv-list' }, h('div', { className: 'dcv-skel' }), h('div', { className: 'dcv-skel' }))
          : visible.length === 0
            ? h('div', { className: 'dcv-empty' },
              h('strong', null, entries.length === 0 ? '还没有保存任何凭据' : '没有匹配的凭据'),
              h('span', null, entries.length === 0 ? '点右上角「新增凭据」，添加网页系统、GitHub 或 SSH 服务器。' : '换个关键词或筛选条件试试。'))
            : h('div', { className: 'dcv-list' },
              visible.map((entry) => h(EntryCard, {
                key: entry.id,
                entry,
                revealed: revealed[entry.id] || {},
                busy: busyId,
                confirming: confirmId === entry.id,
                onReveal: reveal,
                onHide: hide,
                onCopy: copy,
                onEdit: (item) => {
                  setEditor(draftFromEntry(item, revealed[item.id]))
                  setNotice(null)
                },
                onDelete: remove,
              }))),
        notice ? h('div', { className: notice.kind === 'error' ? 'dcv-msg dcv-msgError' : 'dcv-msg dcv-msgOk' }, notice.text) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'credential-vault: install styles')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'credential-vault',
          order: 30,
          label: '凭据管家',
        }, VaultSection))
      },
    }
  },
})
