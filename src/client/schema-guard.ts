/**
 * Content policy for model-authored card schemas.
 *
 * A schema is code, and the renderer treats it that way: it compiles every
 * `JSExpression` / `JSFunction` value through the `customSettings.Function`
 * seam, and when a `componentName` misses the material set it falls back to
 * creating a raw HTML tag. Both are measured, not assumed — SECURITY.md carries
 * the probe table.
 *
 * This module narrows the two paths that need no interaction at all:
 *   - `lifeCycles` hooks, which the renderer awaits while mounting;
 *   - the HTML fallback for tags that can fetch or run code, plus
 *     `javascript:`-style URLs in attributes the browser acts on.
 *
 * It does **not** make a card inert. Property, state, refs, methods, condition
 * and loop expressions still evaluate during mount, and benign HTML tags still
 * render. Closing that needs an expression allowlist or a sandboxed frame; both
 * change what cards can do, so neither is decided here (see SECURITY.md).
 */

/** Schema key holding the render-time hooks. */
const LIFECYCLE_KEY = 'lifeCycles'

/**
 * Tags refused when the renderer falls back to raw HTML.
 * Every one of these can load a document or run script; the benign tags the
 * SDK's own examples use (`div`, `span`, headings, tables) are untouched.
 */
const FORBIDDEN_TAGS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'base', 'link', 'meta', 'template',
])

/** Attributes whose string value the browser resolves as a URL. */
const URL_KEYS = new Set(['href', 'src', 'srcdoc', 'action', 'formaction', 'poster', 'data', 'xlink:href'])

/** URL schemes that run code or load a document of the attacker's choosing. */
const SCRIPT_URL = /^\s*(?:(?:javascript|vbscript)\s*:|data\s*:\s*text\/html)/i

/** Sentinel telling a parent collection to drop this node / key. */
const DROPPED = Symbol('dsh-genui-dropped')

/** Options for {@link stripLifecycleScripts}. */
export interface SchemaGuardOptions {
  /**
   * Keep `lifeCycles` as authored.
   * Only for hosts that deliberately accept model code running at render time;
   * the DSH plugin never passes it.
   */
  readonly allowLifecycleScripts?: boolean | undefined
}

/** The policed schema plus an account of what the policy removed. */
export interface SchemaGuardResult {
  /** Schema safe to hand to the renderer. */
  readonly value: unknown
  /** How many `lifeCycles` blocks were dropped. */
  readonly removed: number
  /** Tag names refused because they can load or run code. */
  readonly blockedTags: readonly string[]
  /** How many URL-valued attributes were refused. */
  readonly blockedUrls: number
}

interface Counters {
  removed: number
  blockedTags: string[]
  blockedUrls: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copy only the nodes that change, so untouched schema keeps its identity. */
function scrub(node: unknown, counters: Counters, options: SchemaGuardOptions): unknown {
  if (Array.isArray(node)) {
    let changed = false
    const mapped: unknown[] = []
    for (const item of node) {
      const next = scrub(item, counters, options)
      if (next !== item) changed = true
      if (next === DROPPED) {
        changed = true
        continue
      }
      mapped.push(next)
    }
    return changed ? mapped : node
  }
  if (!isPlainObject(node)) return node

  const componentName = typeof node.componentName === 'string'
    ? node.componentName.trim().toLowerCase()
    : ''
  if (componentName !== '' && FORBIDDEN_TAGS.has(componentName)) {
    counters.blockedTags.push(componentName)
    return DROPPED
  }

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(node)) {
    if (key === LIFECYCLE_KEY && options.allowLifecycleScripts !== true) {
      counters.removed += 1
      changed = true
      continue
    }
    if (URL_KEYS.has(key.toLowerCase()) && typeof child === 'string' && SCRIPT_URL.test(child)) {
      counters.blockedUrls += 1
      changed = true
      continue
    }
    const mapped = scrub(child, counters, options)
    if (mapped !== child) changed = true
    if (mapped === DROPPED) {
      changed = true
      continue
    }
    next[key] = mapped
  }
  return changed ? next : node
}

/**
 * Apply the card content policy to a parsed schema.
 * Removal happens at any depth: the renderer honors a nested `lifeCycles` no
 * differently from a root one, and a hostile tag is a hostile tag wherever it
 * sits.
 * @param value - parsed schema, or any value inside one.
 * @param options - policy overrides.
 * @returns The policed value and an account of what was removed.
 */
export function stripLifecycleScripts(
  value: unknown,
  options: SchemaGuardOptions = {},
): SchemaGuardResult {
  const counters: Counters = { removed: 0, blockedTags: [], blockedUrls: 0 }
  if (options.allowLifecycleScripts === true && value === undefined) {
    return { value, removed: 0, blockedTags: [], blockedUrls: 0 }
  }
  const guarded = options.allowLifecycleScripts === true
    ? scrub(value, counters, { allowLifecycleScripts: true })
    : scrub(value, counters, {})
  return {
    value: guarded === DROPPED ? {} : guarded,
    removed: counters.removed,
    blockedTags: counters.blockedTags,
    blockedUrls: counters.blockedUrls,
  }
}
