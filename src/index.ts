import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RoleStore, type Role, type RoleInput } from './store.js'

/** Plugin id — must be unique within the composed plugin tree. */
export const name = 'dsh-role-manager'

/** Declare the host services this plugin needs; the loader waits for them. */
export const inject = ['systemPrompt', 'connection']

/** Declarative, schema-validated deployment configuration. */
export interface Config {
  /** Path to the YAML file storing roles. Defaults to ~/.dsh/roles.yaml. */
  storagePath?: string
  /** Role id to activate on boot when present. */
  defaultRole?: string
  /** Order of the role section in the system prompt (after the persona at 0). */
  sectionOrder?: number
  /**
   * When true (default) and the conversation has not started, the active role
   * replaces the whole system prompt; after the first user turn it is appended.
   */
  replaceBeforeStart?: boolean
}

export const Config = Schema.object({
  storagePath: Schema.string().description(
    'Path to the YAML file storing roles. Defaults to ~/.dsh/roles.yaml.',
  ),
  defaultRole: Schema.string().description('Role id to activate on boot when it exists.'),
  sectionOrder: Schema.number().default(1).description(
    'Order of the role section in the system prompt (the persona sits at 0).',
  ),
  replaceBeforeStart: Schema.boolean().default(true).description(
    'Before the first user turn, the active role replaces the entire system prompt; afterwards it is appended.',
  ),
})

/** The system-prompt section name our active role contributes under. */
const SECTION_NAME = 'role-manager:active'
/** Logical RPC channel we own for role management. */
const RPC_CHANNEL = '/rpc'
/** Endpoint prefix claimed by this plugin's host handler. */
const RPC_PREFIX = 'role-manager/'

/** Minimal shape of the host connection service we consume. */
interface HostRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>,
    options: { authority: 'loopback' | 'trusted-host' },
  ): () => Promise<void>
}
interface RpcResult {
  ok: boolean
  value?: unknown
  error?: { message: string }
}

/**
 * Plugin entry point (named export, no default export).
 *
 * Wires the role roster to the system-prompt registry: a live section reads the
 * active role's prompt on every assembly, so switching roles updates the next
 * turn with no re-registration. The `complete` flag (replace vs append) is
 * decided at switch time from whether the conversation has started. A host RPC
 * channel lets the Web client manage the roster.
 */
export function apply(ctx: Context, config: Config): void {
  const storagePath = config.storagePath ?? join(homedir(), '.dsh', 'roles.yaml')
  const store = new RoleStore(storagePath)
  store.load()

  const systemPrompt = ctx.get('systemPrompt') as {
    section: (section: {
      name: string
      order: number
      text: string | ((context: unknown) => string)
      complete?: boolean
    }) => () => void
  }

  // Track whether the conversation has begun. The first agent request means the
  // user has sent at least one message, so later role switches append instead
  // of replacing the already-established system prompt.
  let conversationStarted = false
  ;(ctx as { on: (name: string, fn: (...args: any[]) => any) => void }).on(
    'agent/request',
    (_payload: unknown, next: () => Promise<unknown>) => {
      conversationStarted = true
      return next()
    },
  )

  // Exactly one role section is mounted at a time. Its text is a LIVE function
  // reading the active role, so editing the active role's prompt or switching
  // roles is reflected on the next assembly with no re-registration. Only the
  // `complete` policy (replace vs append) requires re-registering.
  let sectionDispose: (() => void) | undefined
  const registerActiveSection = (complete: boolean): void => {
    sectionDispose?.()
    sectionDispose = systemPrompt.section({
      name: SECTION_NAME,
      order: config.sectionOrder ?? 1,
      text: () => store.getActive()?.prompt ?? '',
      ...(complete ? { complete: true } : {}),
    })
  }

  /** Activate a role (or clear with null) and re-decide replace-vs-append. */
  const setActive = (id: string | null): void => {
    store.setActive(id)
    const complete = (config.replaceBeforeStart ?? true) && !conversationStarted
    registerActiveSection(complete)
    store.save()
  }

  // Boot: activate the configured default, else mount an empty (no-op) section.
  if (config.defaultRole !== undefined && store.getById(config.defaultRole) !== undefined) {
    setActive(config.defaultRole)
  } else {
    registerActiveSection(false)
  }

  ctx.effect(() => () => { sectionDispose?.() }, 'role-manager: section')

  // ── Host RPC handler ──────────────────────────────────────────────────────
  const connection = ctx.get('connection') as { rpc?: HostRpc } | undefined
  if (connection === undefined) {
    ctx.logger.warn('dsh-role-manager: no connection service; Web client RPC disabled')
  }

  const handler = async (
    endpoint: string,
    payload: unknown,
    _signal: AbortSignal,
  ): Promise<RpcResult> => {
    if (!endpoint.startsWith(RPC_PREFIX)) {
      return { ok: false, error: { message: `unknown endpoint ${endpoint}` } }
    }
    const args = ((payload as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>
    try {
      switch (endpoint.slice(RPC_PREFIX.length)) {
        case 'list':
          return { ok: true, value: { roles: store.list(), activeId: store.getActiveId() } }
        case 'get':
          return { ok: true, value: store.getActive() ?? null }
        case 'create': {
          const role = store.create(args as unknown as RoleInput)
          store.save()
          return { ok: true, value: role }
        }
        case 'update': {
          const id = args.id as string
          const role = store.update(id, args as Partial<RoleInput>)
          store.save()
          return { ok: true, value: role }
        }
        case 'delete': {
          store.remove(args.id as string)
          store.save()
          return { ok: true, value: null }
        }
        case 'switch': {
          setActive((args.id as string | null) ?? null)
          return { ok: true, value: { activeId: store.getActiveId() } }
        }
        default:
          return { ok: false, error: { message: `unknown endpoint ${endpoint}` } }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { message } }
    }
  }

  let rpcDispose: (() => void) | undefined
  if (connection?.rpc !== undefined) {
    try {
      const remove = connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'loopback' })
      rpcDispose = () => { void remove() }
    } catch (err) {
      ctx.logger.error(`dsh-role-manager: failed to register RPC: ${String(err)}`)
    }
  }
  ctx.effect(() => () => { rpcDispose?.() }, 'role-manager: rpc')
}
