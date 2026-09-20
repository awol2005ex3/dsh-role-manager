/**
 * 角色管理插件 · 浏览器端 bundle 模块体。
 *
 * 构建契约（deepseek-harness packages/client/tsdown.client.ts 的闭包工厂格式）：
 * 本文件经 tsc 编译后，由 scripts/wrap-client.mjs 包上
 *   banner: window.__ModuleLoader__.load({ id, factory: (require) => {
 *   intro : var module = { exports: {} }; var exports = module.exports;
 *   footer: return module.exports; } });
 * 成为惰性 CJS bundle。副作用全部位于工厂闭包内，待浏览器 shell 物化时运行。
 *
 * 本文件刻意不含任何 import/export 语句（除结尾的 module.exports 赋值），
 * 以便 wrap 脚本能干净地包上闭包外壳。所有类型以 any 处理，避免引入外部 d.ts。
 *
 * 功能：通过 ctx.connection.rpc 调用宿主端 /api/role-manager/* 角色管理端点，提供
 * 角色列表、切换、新建、编辑、删除的界面。配置面板挂载进 dsh 自身设置页
 * （优先 slots.register('settings.section')，回退设置对话框 DOM 锚点），
 * 参考 dsh-logo-custom 的实现；不再占用侧边栏。
 */

const PLUGIN_ID = 'dsh-role-manager'
// 共享 /api 通道（harness 0.1.5+）：宿主端以 connection.fetch.register() 在
// /api/role-manager/<ep> 挂精确路由，浏览器 transport POST /api/<endpoint>。
const RPC_CHANNEL = '/api'
const RPC_PREFIX = 'role-manager/'

/** 构建外壳（scripts/wrap-client.mjs 的 intro）注入的 CJS 语义，仅类型层面使用。 */
declare const module: { exports: unknown }
declare function require(id: string): any

/* 浏览器全局的窄访问面 */
const win = window as unknown as {
  __dshRoleManagerMounted?: boolean
}
const doc = document

/* ── 工具函数 ── */

type ElProps = { style?: string; [key: string]: unknown }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'style') node.setAttribute('style', value as string)
      else (node as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (children) {
    for (const c of children) node.append(typeof c === 'string' ? doc.createTextNode(c) : c)
  }
  return node
}

interface Role {
  id: string
  name: string
  prompt: string
  description?: string
  introHtml?: string
}

/* ── RPC 调用 ── */

interface RpcResponse {
  ok: boolean
  value?: unknown
  error?: { message: string }
}

async function callRpc(conn: any, endpoint: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await conn.rpc.call(RPC_CHANNEL, `${RPC_PREFIX}${endpoint}`, { args })) as RpcResponse
  if (!res || res.ok !== true) {
    throw new Error(res?.error?.message ?? 'rpc error')
  }
  return res.value
}

/* ── 面板（嵌入设置页，流式布局） ── */

const PANEL_CSS = [
  'position:relative;width:100%;max-width:560px;box-sizing:border-box;',
  'overflow:auto;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.25);',
  'border-radius:12px;font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
  'padding:14px;margin:8px 0;',
].join('')

const BTN_CSS = [
  'margin:4px 6px 4px 0;padding:5px 12px;font-size:12px;cursor:pointer;',
  'border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;border-radius:6px;',
].join('')

const PRIMARY_CSS = 'background:#1f6feb;color:#fff;border:1px solid #1f6feb;'

/* 介绍页浮层样式 */
const INTRO_OVERLAY_CSS = [
  'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;',
  'background:rgba(0,0,0,.45);',
].join('')
const INTRO_BOX_CSS = [
  'width:560px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;',
  'background:#fff;color:#1f2328;border-radius:12px;',
  'box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden;',
  'font:14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
].join('')
const INTRO_BODY_CSS = 'flex:1;overflow:auto;padding:16px 20px;'

/* 角色首页：注入到空白会话 hero 标题区的容器样式 */
const HERO_INTRO_CSS = [
  'width:100%;max-height:46vh;overflow:auto;padding:4px 16px 12px;text-align:center;',
  'color:inherit;font:14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
].join('')

function showIntro(role: Role): void {
  const body = el('div', { style: INTRO_BODY_CSS })
  // 内容为用户自己编写的角色介绍 HTML；本地单用户工具，直接渲染。
  body.innerHTML = role.introHtml ?? ''
  const close = makeButton('关闭', () => overlay.remove(), true)
  const overlay = el('div', { style: INTRO_OVERLAY_CSS }, [
    el('div', { style: INTRO_BOX_CSS }, [
      el('div', {
        style: 'display:flex;justify-content:space-between;align-items:center;' +
          'padding:12px 20px;border-bottom:1px solid #eaecef;',
      }, [
        el('div', { style: 'font-weight:700;font-size:15px;', textContent: `🎭 ${role.name} · 角色介绍` }),
        close,
      ]),
      body,
    ]),
  ])
  // 点击遮罩空白处关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  doc.body.append(overlay)
}

function makeButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const btn = el('button', { textContent: label, style: BTN_CSS + (primary ? PRIMARY_CSS : '') })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

function buildPanel(conn: any): { root: HTMLElement; refresh: () => void; onList?: (roles: Role[], activeId: string | null) => void } {
  let onList: ((roles: Role[], activeId: string | null) => void) | undefined
  const status = el('div', { style: 'margin:6px 0;min-height:16px;opacity:.7;' })
  const listBox = el('div', { style: 'margin:8px 0;display:flex;flex-direction:column;gap:6px;' })

  let roles: Role[] = []
  let activeId: string | null = null
  let selectedId: string | null = null

  const form = el('div', { style: 'margin-top:10px;border-top:1px solid rgba(127,127,127,.25);padding-top:10px;display:none;' })
  const INPUT_CSS = 'width:100%;box-sizing:border-box;padding:5px 8px;margin-bottom:6px;' +
    'border:1px solid rgba(127,127,127,.25);border-radius:6px;background:transparent;color:inherit;'
  const nameInput = el('input', {
    placeholder: '角色名称',
    style: INPUT_CSS,
  }) as HTMLInputElement
  const descInput = el('input', {
    placeholder: '描述（可选）',
    style: INPUT_CSS,
  }) as HTMLInputElement
  const promptInput = el('textarea', {
    placeholder: '系统提示词（支持多行 / 换行）',
    style: INPUT_CSS + 'min-height:90px;resize:vertical;',
  }) as HTMLTextAreaElement
  const introInput = el('textarea', {
    placeholder: '角色介绍页 HTML（可选，应用角色时弹出展示该角色能干什么）',
    style: INPUT_CSS + 'min-height:70px;resize:vertical;font-family:Consolas,monospace;',
  }) as HTMLTextAreaElement
  let editingId: string | null = null

  function openForm(role?: Role): void {
    editingId = role?.id ?? null
    nameInput.value = role?.name ?? ''
    descInput.value = role?.description ?? ''
    promptInput.value = role?.prompt ?? ''
    introInput.value = role?.introHtml ?? ''
    form.style.display = 'block'
  }
  function closeForm(): void {
    editingId = null
    nameInput.value = ''
    descInput.value = ''
    promptInput.value = ''
    introInput.value = ''
    form.style.display = 'none'
  }

  function renderList(): void {
    listBox.replaceChildren()
    if (roles.length === 0) {
      listBox.append(el('div', { style: 'opacity:.6;', textContent: '暂无角色，请在下方新建。' }))
      return
    }
    for (const role of roles) {
      const radio = el('input', { type: 'radio', name: 'dsh-role', value: role.id }) as HTMLInputElement
      radio.checked = selectedId === role.id
      radio.addEventListener('change', () => { selectedId = role.id })
      const label = el('label', {
        style: 'display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid rgba(127,127,127,.25);border-radius:8px;cursor:pointer;',
      }, [radio])
      const text = el('div', { style: 'flex:1;' }, [
        el('div', { style: 'font-weight:600;', textContent: role.name + (activeId === role.id ? ' （当前）' : '') }),
        ...(role.description ? [el('div', { style: 'opacity:.7;font-size:12px;', textContent: role.description })] : []),
        el('div', {
          style: 'opacity:.55;font-size:11px;white-space:pre-wrap;',
          textContent: role.prompt.length > 120 ? `${role.prompt.slice(0, 120)}…` : role.prompt,
        }),
      ])
      label.append(text)
      const actions = el('div', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
        makeButton('编辑', () => openForm(role)),
        ...(role.introHtml ? [makeButton('介绍', () => showIntro(role))] : []),
        makeButton('删除', async () => {
          if (!window.confirm(`删除角色「${role.name}」？`)) return
          try {
            await callRpc(conn, 'delete', { id: role.id })
            if (selectedId === role.id) selectedId = null
            await refresh()
          } catch (err) {
            setStatus(err)
          }
        }),
      ])
      label.append(actions)
      listBox.append(label)
    }
  }

  async function refresh(): Promise<void> {
    try {
      const data = (await callRpc(conn, 'list', {})) as { roles: Role[]; activeId: string | null }
      roles = data.roles ?? []
      activeId = data.activeId
      if (selectedId === null) selectedId = activeId
      renderList()
      setStatus('')
      if (onList) onList(roles, activeId)
    } catch (err) {
      setStatus(err)
    }
  }

  function setStatus(err: unknown): void {
    status.textContent = err instanceof Error ? `错误：${err.message}` : ''
  }

  /* 表单操作 */
  const saveBtn = makeButton('保存', async () => {
    const name = nameInput.value.trim()
    const prompt = promptInput.value
    if (!name || !prompt.trim()) {
      setStatus(new Error('名称和提示词均为必填'))
      return
    }
    try {
      const introHtml = introInput.value.trim() || undefined
      if (editingId) {
        await callRpc(conn, 'update', { id: editingId, name, prompt, description: descInput.value.trim() || undefined, introHtml })
      } else {
        await callRpc(conn, 'create', { name, prompt, description: descInput.value.trim() || undefined, introHtml })
      }
      closeForm()
      await refresh()
    } catch (err) {
      setStatus(err)
    }
  }, true)
  const cancelBtn = makeButton('取消', () => closeForm())
  form.append(
    el('div', { style: 'font-weight:600;margin-bottom:6px;', textContent: '新建 / 编辑角色' }),
    nameInput,
    descInput,
    promptInput,
    introInput,
    el('div', {}, [saveBtn, cancelBtn]),
  )

  /* 主操作区 */
  const applyBtn = makeButton('应用选中角色', async () => {
    try {
      await callRpc(conn, 'switch', { id: selectedId })
      await refresh()
    } catch (err) {
      setStatus(err)
    }
  }, true)
  const clearBtn = makeButton('清空角色', async () => {
    try {
      await callRpc(conn, 'switch', { id: null })
      selectedId = null
      await refresh()
    } catch (err) {
      setStatus(err)
    }
  })
  const newBtn = makeButton('新建角色', () => openForm())

  const root = el('div', { style: PANEL_CSS }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' }, [
      el('div', { style: 'font-weight:700;font-size:14px;', textContent: '🎭 角色管理' }),
      newBtn,
    ]),
    status,
    listBox,
    el('div', {}, [applyBtn, clearBtn]),
    form,
  ])

  // 首次打开时拉取一次
  void refresh()
  return { root, refresh, get onList() { return onList }, set onList(fn) { onList = fn } }
}

/* ── 设置页挂载（参考 dsh-logo-custom） ── */

/** 在设置对话框 DOM 中查找可挂载的容器锚点（slots 注册失败时的回退路径）。 */
function findSettingsHost(): HTMLElement | null {
  const selectors = [
    '[data-slot="settings.plugin.item"]',
    '[data-slot="settings.plugins.tab"]',
    '[data-slot="settings.section"]',
    '[data-slot="settings.content"]',
    '[data-slot="settings.body"]',
  ]
  for (const sel of selectors) {
    const node = doc.querySelector(sel)
    if (node instanceof HTMLElement) return node
  }
  return null
}

function mountPanelInSettings(panel: HTMLElement, refresh: () => void): void {
  const host = findSettingsHost()
  if (!host) {
    if (panel.parentElement) panel.remove()
    return
  }
  if (panel.parentElement !== host) {
    host.append(panel)
    refresh()
  }
}

/** 回退路径下设置页导航可能缺少分区标题，为空的导航按钮补一个 label。 */
function fillEmptySettingsNav(): void {
  const dialog = doc.querySelector('[role="dialog"]')
  if (!dialog) return
  dialog.querySelectorAll('button, [role="tab"]').forEach(function (btn) {
    if (!(btn instanceof HTMLElement)) return
    if (btn.dataset.dshRoleNav === 'true') return
    if (btn.closest('#dsh-role-manager-panel')) return
    if (btn.getAttribute('aria-label')) return
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) return
    if (btn.offsetWidth < 72) return
    btn.dataset.dshRoleNav = 'true'
    const span = doc.createElement('span')
    span.textContent = SECTION_LABEL
    btn.appendChild(span)
  })
}

const SECTION_LABEL = '角色管理'

/**
 * 优先走 dsh 的 slots 服务，把面板注册为设置页的独立分区（settings.section）。
 * 独立构建无 JSX，用 require('react') 取宿主 React 运行时 + createElement 手写
 * 组件：容器 ref 里 appendChild 已构建好的 DOM 面板。
 * @returns 是否成功走上 slots 注册路径（false 时调用方回退 DOM 挂载）。
 */
function tryRegisterSettingsSlot(ctx: any, panel: HTMLElement, refresh: () => void): boolean {
  const register = (slots: any) => {
    let React: any
    try { React = require('react') } catch { return false }
    if (!React || typeof React.createElement !== 'function') return false

    function RoleSettings() {
      const ref = React.useRef(null)
      React.useEffect(function () {
        const node = ref.current as HTMLElement | null
        if (!node) return
        node.appendChild(panel)
        refresh()
      }, [])
      return React.createElement('div', { ref, 'data-dsh-role-settings': 'true' })
    }

    function NavIcon(props: Record<string, unknown>) {
      return React.createElement(
        'svg',
        Object.assign({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, props),
        React.createElement('circle', { cx: 12, cy: 8, r: 4 }),
        React.createElement('path', { d: 'M4 21c0-4 3.6-7 8-7s8 3 8 7' }),
      )
    }

    const sectionOpts = {
      id: PLUGIN_ID,
      label: SECTION_LABEL,
      title: SECTION_LABEL,
      icon: NavIcon,
    }

    const tryOne = (slotName: string, opts: Record<string, unknown>) => {
      try {
        if (typeof slots.inject === 'function') {
          slots.inject(slotName, function () {
            return slots.register({ name: slotName, ...opts }, RoleSettings)
          })
          return true
        }
        slots.register({ name: slotName, ...opts }, RoleSettings)
        return true
      } catch {
        return false
      }
    }

    if (tryOne('settings.section', sectionOpts)) return true
    if (tryOne('settings.plugin.item', { key: PLUGIN_ID, label: SECTION_LABEL })) return true
    if (tryOne('settings.plugins.tab', { id: PLUGIN_ID, label: SECTION_LABEL })) return true
    return false
  }

  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['slots'], function (scope: any) {
        register(scope.slots)
      })
      return true
    }
    const slots = ctx?.get?.('slots') ?? ctx?.slots
    if (slots) return register(slots)
  } catch { /* fall through to DOM mount */ }
  return false
}

/* ── 客户端插件契约（浏览器半 fiber 使用；inject 请求 connection 服务） ── */

function apply(ctx: any): void {
  const conn = ctx.connection
  if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
    // 无 connection 时静默退出；宿主端功能（系统提示词注入）仍生效。
    return
  }
  if (win.__dshRoleManagerMounted === true) return
  win.__dshRoleManagerMounted = true

  const handle = buildPanel(conn)
  const panel = handle.root
  panel.id = 'dsh-role-manager-panel'

  /* ── 角色首页：把空白会话 hero（"探索未至之境"标题区）替换为角色介绍 ──
   * harness 的 hero 标题行结构固定：div.headline > span.fishHitbox >
   * [data-slot="conversation.hero.brand.mark"]。标题文本没有可注册的
   * slot，因此沿用 DOM 注入模式：隐藏默认标题行，在其原位置
   * （stack 内、headline 前）插入介绍容器；当前会话开始后 hero 整体
   * 卸载，注入节点随之消失，回到空白页时由 MutationObserver 重新挂上。
   */
  let latestActive: Role | undefined
  let heroIntroEl: HTMLDivElement | undefined
  let lastIntroHtml = ''
  const syncHeroIntro = (): void => {
    const mark = doc.querySelector('[data-slot="conversation.hero.brand.mark"]')
    const headline = mark?.parentElement?.parentElement ?? null
    const stack = headline?.parentElement ?? null
    const want = latestActive?.introHtml ?? ''
    if (!headline || !stack || !want) {
      // hero 不在 DOM、或当前角色没有介绍：恢复默认标题并移除注入节点。
      if (heroIntroEl) { heroIntroEl.remove(); heroIntroEl = undefined; lastIntroHtml = '' }
      if (headline && headline.style.display === 'none') headline.style.display = ''
      return
    }
    if (!heroIntroEl) heroIntroEl = el('div', { style: HERO_INTRO_CSS })
    if (lastIntroHtml !== want) { heroIntroEl.innerHTML = want; lastIntroHtml = want }
    if (headline.style.display !== 'none') headline.style.display = 'none'
    if (heroIntroEl.parentElement !== stack) stack.insertBefore(heroIntroEl, headline)
  }

  handle.onList = (roles, activeId) => {
    latestActive = roles.find((r) => r.id === activeId)
    syncHeroIntro()
  }

  const slotted = tryRegisterSettingsSlot(ctx, panel, handle.refresh)

  // 观察 DOM：驱动 hero 同步；未走上 slots 注册路径时兼作设置页挂载回退。
  // 所有 DOM 写操作幂等（见 AGENTS.md「已知坑」）。
  const observer = new MutationObserver(() => {
    syncHeroIntro()
    if (!slotted) {
      fillEmptySettingsNav()
      mountPanelInSettings(panel, handle.refresh)
    }
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true })
  if (!slotted) mountPanelInSettings(panel, handle.refresh)
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
module.exports = { name: PLUGIN_ID, inject: ['connection'], apply }
