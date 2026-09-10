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
/**
 * Exact Fetch-route base under the shared `/api` channel (harness 0.1.5+).
 * The generic `connection.rpc.handle('/rpc', ...)` path regressed in 0.1.5:
 * internally it does `owner.webServer.register(route)` on the connection
 * plugin's own context, whose fiber no longer injects `webServer`, so every
 * out-of-tree `rpc.handle` call throws `cannot get property "webServer"
 * without inject` (the 405 seen in the browser is the static fallback).
 * The sanctioned extension point instead is `connection.fetch.register()`:
 * exact routes below `/api`, dispatched inside Connection's own `/api` route,
 * so the Host/Origin fence, browser authentication, and the JSON body cap are
 * all applied by Connection before our handler runs.
 */
const RPC_BASE = '/api/role-manager'
/** Endpoint prefix claimed by this plugin's host handler. */
const RPC_PREFIX = 'role-manager/'
/** Endpoints exposed as exact Fetch routes under {@link RPC_BASE}. */
const RPC_ENDPOINTS = ['list', 'get', 'create', 'update', 'delete', 'switch'] as const

/**
 * Minimal shape of `connection.fetch` on harness 0.1.5+ (see
 * `packages/client/connection/src/rpc.ts` → `HostConnectionFetch`).
 */
interface ConnectionFetchLike {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered' | 'streaming'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}
/**
 * Carrier-neutral RPC result (harness 0.1.5 wire contract: the browser
 * transport rejects error results lacking `code` or `details`).
 */
interface RpcResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; details: object }
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
  // The harness interpolates `{{name}}` references in every section and THROWS
  // on malformed/unknown ones. Role prompts are free-form user text, so we
  // neutralize the `{{` opener (break it with a zero-width space) — the scanner
  // never matches, braces stay visible, and the prompt can't crash assembly.
  const escapePromptVars = (text: string): string => text.replace(/\{\{/g, '{' + '\u200b' + '{')
  const registerActiveSection = (complete: boolean): void => {
    sectionDispose?.()
    sectionDispose = systemPrompt.section({
      name: SECTION_NAME,
      order: config.sectionOrder ?? 1,
      text: () => escapePromptVars(store.getActive()?.prompt ?? ''),
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
  const connection = ctx.get('connection') as { fetch?: ConnectionFetchLike } | undefined
  if (connection === undefined) {
    ctx.logger.warn('dsh-role-manager: no connection service; Web client RPC disabled')
  }

  const handler = async (
    endpoint: string,
    payload: unknown,
    _signal: AbortSignal,
  ): Promise<RpcResult> => {
    if (!endpoint.startsWith(RPC_PREFIX)) {
      return { ok: false, error: { code: 'role-manager/unknown-endpoint', message: `unknown endpoint ${endpoint}`, details: {} } }
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
          return { ok: false, error: { code: 'role-manager/unknown-endpoint', message: `unknown endpoint ${endpoint}`, details: {} } }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'role-manager/failed', message, details: {} } }
    }
  }

  // ── Host RPC handler (exact Fetch routes under the shared /api channel) ───

  /**
   * Answer one Connection RPC envelope for a single endpoint. The browser
   * transport (`createWebConnectionRpc`) posts
   * `{ type: 'client-request', rpcId, method, payload }` to
   * `/api/role-manager/<endpoint>` and expects HTTP 200 with
   * `{ type: 'server-response', rpcId, result }`; anything else surfaces as a
   * transport failure in the browser.
   */
  const answer = (endpoint: string) => async (request: Request): Promise<Response> => {
    let envelope: { type?: unknown; rpcId?: unknown; payload?: unknown }
    try {
      envelope = await request.json() as typeof envelope
    } catch {
      return new Response('malformed JSON body', { status: 400 })
    }
    if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string') {
      return new Response('malformed rpc envelope', { status: 400 })
    }
    const result = await handler(`${RPC_PREFIX}${endpoint}`, envelope.payload, request.signal)
    return new Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  const fetchRegistry = connection?.fetch
  const routeDisposers: Array<() => unknown> = []
  if (typeof fetchRegistry?.register !== 'function') {
    ctx.logger.warn('dsh-role-manager: connection.fetch registry unavailable; Web client RPC disabled')
  } else {
    for (const endpoint of RPC_ENDPOINTS) {
      try {
        const remove = fetchRegistry.register({
          path: `${RPC_BASE}/${endpoint}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: answer(endpoint),
        })
        routeDisposers.push(remove)
      } catch (err) {
        ctx.logger.error(`dsh-role-manager: failed to register /api route ${RPC_BASE}/${endpoint}: ${String(err)}`)
      }
    }
  }
  ctx.effect(() => () => { for (const remove of routeDisposers) void remove() }, 'role-manager: rpc routes')
}
