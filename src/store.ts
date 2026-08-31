import { parse, stringify } from 'yaml'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** A role: a named preset the user can switch the session into. */
export interface Role {
  /** Stable unique id (used on the wire and in storage). */
  id: string
  /** Human-readable display name. */
  name: string
  /** The preset system-prompt text injected when this role is active. */
  prompt: string
  /** Optional free-form description shown in the UI. */
  description?: string
  /** Optional HTML introduction page shown when the role is activated. */
  introHtml?: string
}

/** Fields a caller supplies when creating or updating a role. */
export interface RoleInput {
  name: string
  prompt: string
  description?: string
  introHtml?: string
}

/** On-disk YAML shape. */
interface FileShape {
  /** Id of the currently active role, or null when none is active. */
  active: string | null
  roles: Role[]
}

/** Derive a stable, url-safe id from a role name plus a time component. */
function genId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role'
  return `${base}-${Date.now().toString(36)}`
}

/**
 * Loads, persists, and mutates the role roster. The store owns the YAML file
 * and the in-memory roster; it is the single source of truth for which role is
 * active. It performs no system-prompt work — that belongs to the plugin, which
 * reads {@link RoleStore.getActive} when assembling the prompt.
 */
export class RoleStore {
  private readonly path: string
  private roles: Role[] = []
  private activeId: string | null = null

  constructor(path: string) {
    this.path = path
  }

  /** Read the YAML file if present; tolerate a missing file, fail on other errors. */
  load(): void {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const data = parse(raw) as Partial<FileShape> | undefined | null
      if (data && Array.isArray(data.roles)) {
        this.roles = data.roles.map((r): Role => ({
          id: r.id,
          name: r.name,
          prompt: r.prompt ?? '',
          ...(r.description === undefined ? {} : { description: r.description }),
          ...(r.introHtml === undefined ? {} : { introHtml: r.introHtml }),
        }))
        this.activeId = data.active ?? null
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (this.activeId !== null && !this.roles.some(r => r.id === this.activeId)) {
      this.activeId = null
    }
  }

  /** Serialize the roster and active id back to YAML (multiline prompts use block scalars). */
  save(): void {
    const data: FileShape = { active: this.activeId, roles: this.roles }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, stringify(data), 'utf8')
  }

  /** All roles (copies, so callers cannot mutate the roster). */
  list(): Role[] {
    return this.roles.map(r => ({ ...r }))
  }

  getById(id: string): Role | undefined {
    return this.roles.find(r => r.id === id)
  }

  /** The currently active role, or undefined when none is selected. */
  getActive(): Role | undefined {
    return this.activeId ? this.getById(this.activeId) : undefined
  }

  /** The id of the active role (or null). */
  getActiveId(): string | null {
    return this.activeId
  }

  /** Select (or clear with null) the active role. */
  setActive(id: string | null): void {
    if (id !== null && !this.roles.some(r => r.id === id)) {
      throw new Error(`role ${id} does not exist`)
    }
    this.activeId = id
  }

  /** Create a role and return its stored copy. */
  create(input: RoleInput): Role {
    const name = input.name?.trim()
    if (!name) throw new Error('role name is required')
    if (input.prompt === undefined) throw new Error('role prompt is required')
    const role: Role = {
      id: genId(name),
      name,
      prompt: input.prompt,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.introHtml === undefined ? {} : { introHtml: input.introHtml }),
    }
    this.roles.push(role)
    return { ...role }
  }

  /** Patch a role's mutable fields and return its stored copy. */
  update(id: string, patch: Partial<RoleInput>): Role {
    const role = this.getById(id)
    if (!role) throw new Error(`role ${id} does not exist`)
    if (patch.name !== undefined) role.name = patch.name
    if (patch.prompt !== undefined) role.prompt = patch.prompt
    if (patch.description !== undefined) role.description = patch.description
    if (patch.introHtml !== undefined) role.introHtml = patch.introHtml
    return { ...role }
  }

  /** Remove a role; clears the active selection if it was active. */
  remove(id: string): void {
    const idx = this.roles.findIndex(r => r.id === id)
    if (idx < 0) throw new Error(`role ${id} does not exist`)
    this.roles.splice(idx, 1)
    if (this.activeId === id) this.activeId = null
  }
}
