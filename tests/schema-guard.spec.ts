import { describe, expect, it } from 'vitest'
import { stripLifecycleScripts } from '../src/client/schema-guard.ts'
import { parseThemedContent } from '../src/client/genui-theme.ts'

/** The shape a model reaches for when it wants code to run while nobody looks. */
const hostile = {
  componentName: 'Page',
  lifeCycles: {
    onMounted: { type: 'JSFunction', value: 'function () { fetch("/api/sessions") }' },
    onUnmounted: { type: 'JSFunction', value: 'function () {}' },
  },
  children: [{ componentName: 'div', children: 'hi' }],
}

const clean = {
  componentName: 'Page',
  children: [{ componentName: 'div', children: 'hi' }],
}

describe('stripLifecycleScripts', () => {
  it('drops the render-time hooks and reports how many it removed', () => {
    const { value, removed } = stripLifecycleScripts(hostile) as { value: Record<string, unknown>; removed: number }
    expect(removed).toBe(1)
    expect(value).not.toHaveProperty('lifeCycles')
    expect(value.componentName).toBe('Page')
    expect(value.children).toEqual([{ componentName: 'div', children: 'hi' }])
  })

  it('leaves the authored schema untouched', () => {
    const { value } = stripLifecycleScripts(hostile)
    expect(hostile.lifeCycles.onMounted.value).toContain('fetch')
    expect(value).not.toHaveProperty('lifeCycles')
  })

  it('keeps identity when there is nothing to drop, so streaming stays cheap', () => {
    const { value, removed, blockedTags, blockedUrls } = stripLifecycleScripts(clean)
    expect(removed).toBe(0)
    expect(value).toBe(clean)
    expect(blockedTags).toEqual([])
    expect(blockedUrls).toBe(0)
  })

  it('refuses the HTML tags that can load or run code, at any depth', () => {
    const schema = {
      componentName: 'Page',
      children: [
        { componentName: 'script', props: { src: 'https://evil.test/x.js' } },
        { componentName: 'SCRIPT', props: { src: 'https://evil.test/y.js' } },
        { componentName: 'iframe', props: { srcdoc: '<script>x</script>' } },
        { componentName: 'object', props: { data: 'https://evil.test/z.swf' } },
        { componentName: 'div', children: [{ componentName: 'embed' }] },
      ],
    }
    const { value, blockedTags } = stripLifecycleScripts(schema) as { value: typeof schema; blockedTags: readonly string[] }
    expect(blockedTags).toEqual(['script', 'script', 'iframe', 'object', 'embed'])
    expect(value.children.map(child => child.componentName)).toEqual(['div'])
    expect(value.children[0]?.children).toEqual([])
  })

  it('keeps the HTML the SDK examples use', () => {
    const schema = {
      componentName: 'Page',
      children: [
        { componentName: 'div', props: { className: 'x' } },
        { componentName: 'h3', children: 'Title' },
        { componentName: 'img', props: { src: 'https://cdn.test/a.png' } },
        { componentName: 'span', children: 'text' },
      ],
    }
    const { value, blockedTags } = stripLifecycleScripts(schema)
    expect(blockedTags).toEqual([])
    expect(value).toBe(schema)
  })

  it('refuses script URLs in the attributes the browser acts on', () => {
    const schema = {
      componentName: 'Page',
      children: [
        { componentName: 'a', props: { href: 'javascript:alert(1)' }, children: 'go' },
        { componentName: 'a', props: { href: '  JaVaScRiPt :alert(2)' }, children: 'go' },
        { componentName: 'img', props: { src: 'data:text/html,<script>x</script>' } },
        { componentName: 'a', props: { href: 'https://ok.test/page' }, children: 'go' },
      ],
    }
    const { value, blockedUrls } = stripLifecycleScripts(schema) as { value: typeof schema; blockedUrls: number }
    expect(blockedUrls).toBe(3)
    expect(value.children.map(child => child.props.href ?? child.props.src))
      .toEqual([undefined, undefined, undefined, 'https://ok.test/page'])
  })

  it('survives values that are not an object', () => {
    expect(stripLifecycleScripts('nope').value).toBe('nope')
    expect(stripLifecycleScripts('nope').removed).toBe(0)
    expect(stripLifecycleScripts(undefined).removed).toBe(0)
    expect(stripLifecycleScripts([{ lifeCycles: {} }]).removed).toBe(1)
  })

  it('has an explicit opt-out for hosts that accept render-time code', () => {
    const { value, removed } = stripLifecycleScripts(hostile, { allowLifecycleScripts: true })
    expect(removed).toBe(0)
    expect(value).toBe(hostile)
  })

  it('still refuses executable tags under that opt-out', () => {
    const { value, blockedTags } = stripLifecycleScripts(
      { componentName: 'Page', children: [{ componentName: 'script' }] },
      { allowLifecycleScripts: true },
    ) as { value: { children: unknown[] }; blockedTags: readonly string[] }
    expect(blockedTags).toEqual(['script'])
    expect(value.children).toEqual([])
  })
})

describe('parseThemedContent policy', () => {
  it('themes charts and applies the policy in one pass', () => {
    const schema = {
      componentName: 'Page',
      lifeCycles: { onMounted: { type: 'JSFunction', value: 'function () { fetch("/api/x") }' } },
      children: [
        { componentName: 'TinyHuichartsLine', props: { options: { data: [1, 2, 3], theme: 'light' } } },
        { componentName: 'script', props: { src: 'https://evil.test/x.js' } },
      ],
    }
    const parsed = parseThemedContent(JSON.stringify(schema), true)
    expect(parsed.isJsonComplete).toBe(true)
    expect(parsed.lifecycleScriptsRemoved).toBe(1)
    expect(parsed.blockedTags).toEqual(['script'])
    expect(parsed.content).toMatchObject({
      children: [{ componentName: 'TinyHuichartsLine', props: { options: { theme: 'cloud-dark' } } }],
    })
    expect(parsed.content).not.toHaveProperty('lifeCycles')
  })

  it('reports nothing to drop for a plain card', () => {
    const parsed = parseThemedContent(JSON.stringify(clean), false)
    expect(parsed.lifecycleScriptsRemoved).toBe(0)
    expect(parsed.blockedTags).toEqual([])
    expect(parsed.content).toMatchObject({ componentName: 'Page' })
  })

  it('hands an unrepairable chunk back to the renderer untouched', () => {
    const parsed = parseThemedContent('hello world', false)
    expect(parsed.content).toBe('hello world')
    expect(parsed.lifecycleScriptsRemoved).toBe(0)
  })

  it('keeps the stream-repair behavior for a half-written schema', () => {
    const parsed = parseThemedContent('{"componentName":', false)
    expect(parsed.content).toEqual({})
    expect(parsed.isJsonComplete).toBe(false)
  })
})
