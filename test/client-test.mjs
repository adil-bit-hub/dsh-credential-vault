/**
 * Client-half test for `dsh-credential-vault`. Run from the package directory:
 *
 *   node test/client-test.mjs
 *
 * `client.js` is a browser module: it registers itself on
 * `window.__ModuleLoader__` and asks for React through the module table. This
 * test supplies a tiny React stand-in with just enough semantics (createElement,
 * Fragment, useState, useEffect, useCallback) to mount the Settings section,
 * drives it with a mocked fetch, and asserts on the rendered tree. No browser,
 * no network, no real credentials.
 */
import assert from 'node:assert/strict'

const h = (type, props, ...children) => ({
  type,
  props: {
    ...(props ?? {}),
    ...(children.length > 0
      ? { children: children.length === 1 ? children[0] : children }
      : (props && 'children' in props ? { children: props.children } : {})),
  },
})

const Fragment = Symbol('fragment')

let currentInstance = null

function useState(initial) {
  const instance = currentInstance
  const slot = instance.slot++
  if (!(slot in instance.states)) {
    instance.states[slot] = typeof initial === 'function' ? initial() : initial
  }
  const setState = (next) => {
    const value = typeof next === 'function' ? next(instance.states[slot]) : next
    if (Object.is(value, instance.states[slot])) return
    instance.states[slot] = value
    instance.dirty = true
  }
  return [instance.states[slot], setState]
}

function useEffect(effect, deps) {
  const instance = currentInstance
  instance.effects.push({ effect, deps })
}

function useCallback(fn) {
  return fn
}

const React = { createElement: h, Fragment, useState, useEffect, useCallback }

class Instance {
  constructor(Component, props) {
    this.Component = Component
    this.props = props
    this.states = []
    this.effects = []
    this.slot = 0
    this.dirty = false
    this.ranEffects = 0
  }

  render() {
    this.slot = 0
    this.effects = []
    const previous = currentInstance
    currentInstance = this
    try {
      return walk(this.Component(this.props))
    } finally {
      currentInstance = previous
    }
  }

  takeEffects() {
    const pending = this.effects.slice(this.ranEffects)
    this.ranEffects = this.effects.length
    return pending.map((entry) => entry.effect)
  }
}

/** Turn a React element tree into plain nodes so tests can inspect it. */
function walk(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { children: node.map(walk).filter(Boolean) }
  const { type, props } = node
  if (type === Fragment) return { children: childrenOf(props).map(walk).filter(Boolean) }
  if (typeof type === 'function') {
    const previous = currentInstance
    const child = new Instance(type, props)
    currentInstance = child
    try {
      return walk(child.Component(child.props))
    } finally {
      currentInstance = previous
    }
  }
  return { tag: type, props, children: childrenOf(props).map(walk).filter(Boolean) }
}

function childrenOf(props) {
  const children = props?.children
  if (children === undefined || children === null || children === false) return []
  return Array.isArray(children) ? children : [children]
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.text !== undefined) return node.text
  return (node.children ?? []).map(textOf).join('')
}

function findByText(node, text, predicate) {
  if (node === null || node === undefined) return null
  if (node.text === text && predicate === undefined) return node
  if (predicate !== undefined && predicate(node, textOf(node))) return node
  for (const child of node.children ?? []) {
    const found = findByText(child, text, predicate)
    if (found !== null) return found
  }
  return null
}

/** Find the clickable element whose whole label is exactly `label`. */
function findClickable(node, label) {
  if (node === null || node === undefined) return null
  if (typeof node.props?.onClick === 'function' && textOf(node).trim() === label) return node
  for (const child of node.children ?? []) {
    const found = findClickable(child, label)
    if (found !== null) return found
  }
  return null
}

function findByClass(node, className) {
  if (node === null || node === undefined) return null
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const found = findByClass(child, className)
    if (found !== null) return found
  }
  return null
}

function findAllByClass(node, className, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className)) out.push(node)
  for (const child of node.children ?? []) findAllByClass(child, className, out)
  return out
}

// --- browser stand-ins -----------------------------------------------------
const requests = []
let listValue = { entries: [], count: 0 }

const fetchMock = async (url, init) => {
  const endpoint = String(url).split('/').pop()
  const body = init?.body ? JSON.parse(init.body) : {}
  requests.push({ endpoint, body })
  let value
  if (endpoint === 'list') value = listValue
  else if (endpoint === 'test') {
    value = { ok: true, protocol: 'socks5', proxy: 'socks5://10.0.0.2:1080', target: 'https://api.ipify.org', status: 200, latencyMs: 123, exitIp: '203.0.113.9', via: 'socks' }
  } else if (endpoint === 'save') value = { entry: { id: 'proxy-abc', type: 'proxy', name: '新代理' } }
  else if (endpoint === 'reveal') value = { value: 'secret' }
  else if (endpoint === 'remove') value = { id: body.id }
  else value = {}
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value }),
  }
}

const styleTags = []
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', style: {}, remove() {}, select() {} }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: { appendChild() {} },
  execCommand: () => true,
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async () => {} } },
})
globalThis.fetch = fetchMock

let registered = null
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { registered = spec } },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

await import('../client.js')
assert.ok(registered !== null, 'client.js registers itself on the module loader')

const module_ = registered.factory((name) => {
  assert.equal(name, 'react', `unexpected module request: ${name}`)
  return React
})

let Component = null
module_.apply({
  effect: (fn) => fn(),
  slots: {
    inject: (_name, fn) => fn(),
    register: (_spec, component) => {
      Component = component
      return {}
    },
  },
})
assert.equal(typeof Component, 'function', 'settings section component registered')

async function mount() {
  const instance = new Instance(Component, {})
  let tree = instance.render()
  for (let round = 0; round < 20; round += 1) {
    const effects = instance.takeEffects()
    for (const effect of effects) await effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!instance.dirty) break
    instance.dirty = false
    tree = instance.render()
  }
  return { tree, rerender: () => { instance.dirty = false; const next = instance.render(); return next } }
}

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('ok  ', name)
}

listValue = {
  entries: [
    {
      id: 'proxy-1a2b3c4d5e6f',
      type: 'proxy',
      name: '公司出口代理',
      note: '访问外网',
      protocol: 'socks5',
      host: '10.0.0.2',
      port: 1080,
      username: 'alice',
      url: 'socks5://10.0.0.2:1080',
      hasPassword: true,
    },
    {
      id: 'ssh-1a2b3c4d5e6f',
      type: 'ssh',
      name: '生产服务器',
      note: '',
      host: '10.0.0.5',
      port: 22,
      username: 'root',
      authMethod: 'key',
      hasPrivateKey: true,
    },
  ],
  count: 2,
}

const mounted = await mount()

await check('渲染代理卡片、协议徽标与目标地址', () => {
  const text = textOf(mounted.tree)
  assert.ok(text.includes('公司出口代理'), 'card name')
  assert.ok(text.includes('SOCKS5'), 'protocol badge')
  assert.ok(text.includes('需认证'), 'auth badge')
  assert.ok(text.includes('socks5://alice@10.0.0.2:1080'), 'target with username')
  assert.ok(text.includes('测试'), 'test action')
  assert.ok(text.includes('复制链接'), 'copy action')
  assert.ok(text.includes('代理 1'), 'proxy filter tab count')
})

await check('点击「测试」调用 Host 并展示结果', async () => {
  const button = findClickable(mounted.tree, '测试')
  assert.ok(button !== null, 'test button found')
  requests.length = 0
  await button.props.onClick()
  assert.deepEqual(requests.map((item) => item.endpoint), ['test'])
  assert.equal(requests[0].body.id, 'proxy-1a2b3c4d5e6f')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = mounted.rerender()
  const text = textOf(tree)
  assert.ok(text.includes('连通正常'), 'success line rendered')
  assert.ok(text.includes('出口 IP'), 'exit ip label')
  assert.ok(text.includes('203.0.113.9'), 'exit ip value')
  assert.ok(text.includes('重测'), 'retest action')
})

await check('编辑器提供代理字段并随协议切换默认端口', async () => {
  const addButton = findClickable(mounted.tree, '新增凭据')
  assert.ok(addButton !== null, 'add button found')
  addButton.props.onClick()
  let tree = mounted.rerender()

  const typeCard = findAllByClass(tree, 'dcv-typeCard').find((node) => textOf(node).startsWith('代理'))
  assert.ok(typeCard !== undefined, 'proxy type card found')
  typeCard.props.onClick()
  tree = mounted.rerender()

  const text = textOf(tree)
  for (const label of ['代理协议', '代理主机', '代理端口', '代理用户名（可选）', '代理密码（可选）']) {
    assert.ok(text.includes(label), `editor shows ${label}`)
  }

  const fields = findAllByClass(tree, 'dcv-field')
  const controls = fields.flatMap((field) => field.children ?? [])
  const select = controls.find((node) => node.tag === 'select')
  assert.ok(select !== undefined, 'protocol select found')
  assert.equal(select.props.value, 'http')
  select.props.onChange({ target: { value: 'socks5' } })
  tree = mounted.rerender()

  const portInput = findAllByClass(tree, 'dcv-field')
    .flatMap((field) => field.children ?? [])
    .find((node) => node.tag === 'input' && node.props.type === 'number')
  assert.ok(portInput !== undefined, 'port input found')
  assert.equal(portInput.props.value, 1080, 'port follows protocol default')
})

console.log(`\nALL PASS (${passed} client checks)`)
