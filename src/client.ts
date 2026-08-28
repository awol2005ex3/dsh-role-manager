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
 * 功能：通过 ctx.connection.rpc 调用宿主端 /rpc 角色管理端点，提供
 * 角色列表、切换、新建、编辑、删除的界面。启动器优先挂入侧边栏
 * [data-slot="sidebar.footer.action"] 插槽，缺失时回退为浮动按钮。
 */

const PLUGIN_ID = 'dsh-role-manager'
const RPC_CHANNEL = '/rpc'
const RPC_PREFIX = 'role-manager/'

/** 构建外壳（scripts/wrap-client.mjs 的 intro）注入的 CJS 语义，仅类型层面使用。 */
declare const module: { exports: unknown }

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

/* ── 浮层界面 ── */

const PANEL_CSS = [
  'position:fixed;left:16px;bottom:64px;z-index:2147483646;width:360px;max-height:70vh;',
  'overflow:auto;background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:12px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.18);font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
  'padding:14px;',
].join('')

const BTN_CSS = [
  'margin:4px 6px 4px 0;padding:5px 12px;font-size:12px;cursor:pointer;',
  'border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;border-radius:6px;',
].join('')

const PRIMARY_CSS = 'background:#1f6feb;color:#fff;border:1px solid #1f6feb;'

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
  const status = el('div', { style: 'margin:6px 0;min-height:16px;color:#57606a;' })
  const listBox = el('div', { style: 'margin:8px 0;display:flex;flex-direction:column;gap:6px;' })

  let roles: Role[] = []
  let activeId: string | null = null
  let selectedId: string | null = null

  const form = el('div', { style: 'margin-top:10px;border-top:1px solid #eaecef;padding-top:10px;display:none;' })
  const nameInput = el('input', {
    placeholder: '角色名称',
    style: 'width:100%;box-sizing:border-box;padding:5px 8px;margin-bottom:6px;border:1px solid #d0d7de;border-radius:6px;',
  }) as HTMLInputElement
  const descInput = el('input', {
    placeholder: '描述（可选）',
    style: 'width:100%;box-sizing:border-box;padding:5px 8px;margin-bottom:6px;border:1px solid #d0d7de;border-radius:6px;',
  }) as HTMLInputElement
  const promptInput = el('textarea', {
    placeholder: '系统提示词（支持多行 / 换行）',
    style: 'width:100%;box-sizing:border-box;padding:5px 8px;min-height:90px;resize:vertical;border:1px solid #d0d7de;border-radius:6px;',
  }) as HTMLTextAreaElement
  let editingId: string | null = null

  function openForm(role?: Role): void {
    editingId = role?.id ?? null
    nameInput.value = role?.name ?? ''
    descInput.value = role?.description ?? ''
    promptInput.value = role?.prompt ?? ''
    form.style.display = 'block'
  }
  function closeForm(): void {
    editingId = null
    nameInput.value = ''
    descInput.value = ''
    promptInput.value = ''
    form.style.display = 'none'
  }

  function renderList(): void {
    listBox.replaceChildren()
    if (roles.length === 0) {
      listBox.append(el('div', { style: 'color:#8b949e;', textContent: '暂无角色，请在下方新建。' }))
      return
    }
    for (const role of roles) {
      const radio = el('input', { type: 'radio', name: 'dsh-role', value: role.id }) as HTMLInputElement
      radio.checked = selectedId === role.id
      radio.addEventListener('change', () => { selectedId = role.id })
      const label = el('label', {
        style: 'display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid #eaecef;border-radius:8px;cursor:pointer;',
      }, [radio])
      const text = el('div', { style: 'flex:1;' }, [
        el('div', { style: 'font-weight:600;', textContent: role.name + (activeId === role.id ? ' （当前）' : '') }),
        ...(role.description ? [el('div', { style: 'color:#57606a;font-size:12px;', textContent: role.description })] : []),
        el('div', {
          style: 'color:#8b949e;font-size:11px;white-space:pre-wrap;',
          textContent: role.prompt.length > 120 ? `${role.prompt.slice(0, 120)}…` : role.prompt,
        }),
      ])
      label.append(text)
      const actions = el('div', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
        makeButton('编辑', () => openForm(role)),
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
      if (editingId) {
        await callRpc(conn, 'update', { id: editingId, name, prompt, description: descInput.value.trim() || undefined })
      } else {
        await callRpc(conn, 'create', { name, prompt, description: descInput.value.trim() || undefined })
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

  const closeBtn = el('button', {
    type: 'button',
    textContent: '✕',
    ariaLabel: '关闭',
    title: '关闭',
    style: 'margin-left:8px;padding:2px 8px;font-size:13px;line-height:1;cursor:pointer;' +
      'border:1px solid #d0d7de;background:#f6f8fa;color:#57606a;border-radius:6px;',
  }) as HTMLButtonElement
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    root.style.display = 'none'
  })

  const root = el('div', { style: PANEL_CSS }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' }, [
      el('div', { style: 'font-weight:700;font-size:14px;', textContent: '🎭 角色管理' }),
      el('div', { style: 'display:flex;align-items:center;gap:6px;' }, [newBtn, closeBtn]),
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

/* ── 客户端插件契约（浏览器半 fiber 使用；inject 请求 connection 服务） ── */

const SIDEBAR_SLOT = 'sidebar.footer.action'
const SIDEBAR_BTN_CSS =
  'display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;' +
  'margin:4px 0;padding:8px 10px;font-size:13px;cursor:pointer;' +
  'border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;' +
  'border-radius:8px;'
const FLOAT_BTN_CSS =
  'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:9px 14px;' +
  'font-size:13px;background:#1f6feb;color:#fff;border:none;border-radius:8px;' +
  'box-shadow:0 2px 8px rgba(0,0,0,.3);margin:0;'

/**
 * 将启动器挂入侧边栏插槽 [data-slot]；找不到或宿主移除时回退为浮动按钮。
 * MutationObserver 用于在 React 重渲染把节点挤出时重新挂回。
 */
function mountLauncher(launcher: HTMLButtonElement): void {
  const styleSidebar = (): void => { launcher.style.cssText = SIDEBAR_BTN_CSS }
  const styleFloat = (): void => { launcher.style.cssText = FLOAT_BTN_CSS }

  function sidebarHost(): Element | null {
    return doc.querySelector(`[data-slot="${SIDEBAR_SLOT}"]`)
  }
  function ensureMounted(): void {
    const host = sidebarHost()
    if (host) {
      if (launcher.parentElement !== host) { host.append(launcher); styleSidebar() }
    } else if (launcher.parentElement !== doc.body) {
      doc.body.append(launcher); styleFloat()
    }
  }

  ensureMounted()
  const observer = new MutationObserver(() => { ensureMounted() })
  observer.observe(doc.documentElement, { childList: true, subtree: true })
}

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
  panel.style.display = 'none'
  panel.id = 'dsh-role-manager-panel'
  doc.body.append(panel)

  const launcher = makeButton('🎭 角色', () => {
    if (panel.style.display === 'none') {
      panel.style.display = 'block'
      handle.refresh()
    } else {
      panel.style.display = 'none'
    }
  })
  launcher.id = 'dsh-role-manager-launcher'

  handle.onList = (roles, activeId) => {
    const active = roles.find((r) => r.id === activeId)
    launcher.textContent = active ? `🎭 ${active.name}` : '🎭 角色'
  }

  mountLauncher(launcher)
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
module.exports = { name: PLUGIN_ID, inject: ['connection'], apply }
