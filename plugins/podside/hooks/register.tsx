import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ClusterInfo, Pod, View } from '../types'

// Read-only: podside only runs kubectl get/logs/describe and never writes to the cluster.

const PANE = 'podside'
const FAST_MS = 5_000
const SLOW_MS = 30_000
const ALL = '_all'
const MAX_ROWS = 300

// Mid-tone colors that read on both dark and light terminals; everything else is dim or plain.
const P = {
  accent: '#2DD4BF',
  ok: '#22C55E',
  warn: '#F59E0B',
  bad: '#EF4444',
}

type Health = 'ok' | 'warn' | 'bad' | 'done'

const GLYPH: Record<Health, { mark: string; color?: string; dim?: boolean }> = {
  ok: { mark: '●', color: P.ok },
  warn: { mark: '◐', color: P.warn },
  bad: { mark: '✕', color: P.bad },
  done: { mark: '○', dim: true },
}

const pods = atom({ plugin: 'podside', key: 'pods' } as const, [] as Pod[])
const selected = atom({ plugin: 'podside', key: 'selected' } as const, null as string | null)
const view = atom({ plugin: 'podside', key: 'view' } as const, 'list' as View)
const detail = atom({ plugin: 'podside', key: 'detail' } as const, '')
const ctx = atom({ plugin: 'podside', key: 'ctx' } as const, '')
const contexts = atom({ plugin: 'podside', key: 'contexts' } as const, [] as string[])
const ns = atom({ plugin: 'podside', key: 'ns' } as const, ALL)
const namespaces = atom({ plugin: 'podside', key: 'namespaces' } as const, [] as string[])
const error = atom({ plugin: 'podside', key: 'error' } as const, null as string | null)
const syncedAt = atom({ plugin: 'podside', key: 'syncedAt' } as const, 0)
const isActive = atom({ plugin: 'podside', key: 'isActive' } as const, false)
const filter = atom({ plugin: 'podside', key: 'filter' } as const, '')
const onlyFailing = atom({ plugin: 'podside', key: 'onlyFailing' } as const, false)
const info = atom(
  { plugin: 'podside', key: 'info' } as const,
  { cluster: '', user: '', k8s: '' } as ClusterInfo,
)

let isPaneOpen = false
let isBusy = false
let lastPoll = 0
let timer: Timer | undefined

async function kubectl($: EngineInterface, args: string[], timeoutMs = 15_000) {
  const context = await read($, ctx)
  const argv = ['kubectl', ...(context ? ['--context', context] : []), ...args]
  const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs })
  if (exitCode !== 0) throw new Error(stderr.trim() || `kubectl exited with code ${exitCode}`)
  return stdout
}

// Parses the `kubectl get pods -o wide` table: kubectl computes STATUS, and the output is far
// smaller than -o json (which can exceed the 4 MiB process output cap on big clusters).
// RESTARTS may contain spaces ("13 (34h ago)"), so the trailing columns are read from the end.
function parsePods(out: string, hasNs: boolean, namespace: string): Pod[] {
  const head = hasNs ? 4 : 3
  return out
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= head + 6)
    .map(cols => {
      const [podNs = '', name = '', ready = '', status = ''] = hasNs ? cols : [namespace, ...cols]
      const [age = '', ip = '', node = ''] = cols.slice(-5)
      const restarts = cols.slice(head, -5).join(' ')
      const [up, total] = ready.split('/')
      return {
        ns: podNs,
        name,
        ready,
        status,
        restarts,
        age,
        ip: ip === '<none>' ? '-' : ip,
        node: node === '<none>' ? '-' : node,
        isHealthy: status === 'Completed' || (status === 'Running' && up === total),
      }
    })
}

function health(p: Pod): Health {
  if (p.status === 'Completed') return 'done'
  if (p.isHealthy) return 'ok'
  const isStarting =
    p.status === 'Pending' ||
    p.status === 'ContainerCreating' ||
    p.status === 'PodInitializing' ||
    p.status === 'Running' ||
    /^Init:\d+\/\d+$/.test(p.status)
  return isStarting ? 'warn' : 'bad'
}

function ago(now: number, then: number) {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m`
}

const fit = (text: string, width: number) =>
  width <= 0 ? '' : text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text.padEnd(width)

const tail = (text: string, max: number) => (text.length > max ? '…\n' + text.slice(-max) : text)

const keyOf = (p: Pod) => `${p.ns}/${p.name}`

// Columns after the status dot, fitted to the pane width
function columns(width: number) {
  const cols: { id: keyof Pod; title: string; width: number }[] = [
    { id: 'name', title: 'name', width: 0 },
    { id: 'ready', title: 'ready', width: 7 },
    { id: 'status', title: 'status', width: 22 },
    { id: 'restarts', title: 'restarts', width: 14 },
  ]
  if (width >= 120) cols.push({ id: 'ip', title: 'ip', width: 17 })
  if (width >= 140) cols.push({ id: 'node', title: 'node', width: 14 })
  cols.push({ id: 'age', title: 'age', width: 7 })
  const fixed = cols.reduce((n, c) => n + c.width, 0)
  cols[0]!.width = Math.max(16, width - 4 - fixed) // gutter, dot and a space
  return cols
}

async function refreshContexts($: EngineInterface) {
  try {
    const { stdout } = await $.process.run(['kubectl', 'config', 'get-contexts', '-o', 'name'])
    await update($, contexts, () => stdout.split('\n').map(s => s.trim()).filter(Boolean))
    if (!(await read($, ctx))) {
      const cur = await $.process.run(['kubectl', 'config', 'current-context'])
      await update($, ctx, () => cur.stdout.trim())
    }
    const out = await kubectl($, ['get', 'ns', '-o', 'jsonpath={.items[*].metadata.name}'])
    await update($, namespaces, () => out.split(/\s+/).filter(Boolean))
    const who = await kubectl($, [
      'config', 'view', '--minify', '-o',
      'jsonpath={.contexts[0].context.cluster} {.contexts[0].context.user}',
    ]).catch(() => '')
    const [cluster = '-', user = '-'] = who.trim().split(' ')
    const version = await kubectl($, ['version', '-o', 'json'], 5_000).catch(() => '{}')
    let k8s = ''
    try {
      k8s = JSON.parse(version).serverVersion?.gitVersion ?? ''
    } catch {}
    await update($, info, () => ({ cluster, user, k8s }))
  } catch (err) {
    await update($, error, () => String((err as Error).message ?? err))
  }
}

async function refreshPods($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    const namespace = await read($, ns)
    const scope = namespace === ALL ? ['-A'] : ['-n', namespace]
    const out = await kubectl($, ['get', 'pods', ...scope, '-o', 'wide', '--no-headers'])
    const list = parsePods(out, namespace === ALL, namespace)
    await update($, pods, () => list)
    await update($, error, () => null)
    const stamp = await $.clock.now()
    await update($, syncedAt, () => stamp)
    // The log view follows: refresh it with the list
    if ((await read($, view)) === 'logs') await loadDetail($, 'logs', false)
  } catch (err) {
    await update($, error, () => String((err as Error).message ?? err).split('\n')[0] ?? '')
  } finally {
    isBusy = false
    lastPoll = await $.clock.now()
  }
}

async function activate($: EngineInterface) {
  await update($, isActive, () => true)
  if (!timer) {
    // Every 5 s while the pane is open, every 30 s otherwise (for the band).
    timer = $.clock.every(FAST_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        if (isPaneOpen || now - lastPoll >= SLOW_MS) await refreshPods($)
      })()
    })
  }
  await refreshContexts($)
  await refreshPods($)
}

async function openPane($: EngineInterface) {
  isPaneOpen = true
  await $.ui.open({ id: PANE, title: 'podside', focus: true })
}

async function setNamespace($: EngineInterface, value: string) {
  await update($, ns, () => value)
  await update($, selected, () => null)
  await update($, view, () => 'list')
  await refreshPods($)
}

async function nextNamespace($: EngineInterface) {
  const order = [ALL, ...(await read($, namespaces))]
  const at = order.indexOf(await read($, ns))
  await setNamespace($, order[(at + 1) % order.length] ?? ALL)
}

async function loadDetail($: EngineInterface, kind: 'logs' | 'describe', isFirst = true) {
  const key = await read($, selected)
  if (!key) {
    if (isFirst) $.ui.toast('Select a pod first')
    return
  }
  const [podNs = '', podName = ''] = key.split('/')
  if (isFirst) {
    await update($, view, () => kind)
    await update($, detail, () => 'Loading…')
  }
  try {
    const out =
      kind === 'logs'
        ? await kubectl($, ['logs', '-n', podNs, podName, '--all-containers=true', '--tail=300'])
        : await kubectl($, ['describe', 'pod', '-n', podNs, podName])
    await update($, detail, () => out.trimEnd() || '(empty)')
  } catch (err) {
    await update($, detail, () => `Error: ${(err as Error).message}`)
  }
}

async function askClaude($: EngineInterface) {
  const key = await read($, selected)
  if (!key) {
    $.ui.toast('Select a pod first')
    return
  }
  const [podNs = '', podName = ''] = key.split('/')
  const context = await read($, ctx)
  $.ui.toast(`Collecting details for ${podName}…`)
  const grab = (args: string[]) => kubectl($, args).catch(err => `Error: ${(err as Error).message}`)
  const [describe, logs] = await Promise.all([
    grab(['describe', 'pod', '-n', podNs, podName]),
    grab(['logs', '-n', podNs, podName, '--all-containers=true', '--tail=120']),
  ])
  await $.prompt.submit({
    text: [
      `Investigate this Kubernetes pod: context \`${context}\`, namespace \`${podNs}\`, pod \`${podName}\`.`,
      'Explain its state, the root cause of any problem, and a suggested fix. Do not run commands that write to the cluster; ask me first if one is needed.',
      '',
      '### kubectl describe',
      '```',
      tail(describe, 8000),
      '```',
      '',
      '### Recent logs',
      '```',
      tail(logs, 6000),
      '```',
    ].join('\n'),
  })
  $.ui.toast('Sent to Claude')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'podside',
      description: 'Open the Kubernetes pod pane',
      argumentHint: '[namespace|all]',
    })
    // Module variables reset on reload; ask the engine whether the pane is still open
    isPaneOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (await read($, isActive)) void activate($)
    return next(e)
  })

  on('command.run', { command: 'podside' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg) await setNamespace($, arg === 'all' ? ALL : arg)
    await openPane($)
    void activate($)
    return { text: 'podside pane opened.' }
  })

  // Moving the focus onto a row selects that pod, so the arrow keys pick pods directly
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const el = e.element
    if (el?.startsWith('pod:')) {
      const key = el.slice(4)
      if ((await read($, selected)) !== key) await update($, selected, () => key)
    }
    return next(e)
  })

  // While the pane is open and a pod is selected, attach that pod to the user's prompt as context
  on('prompt.submit', async ($, e, next) => {
    const key = await read($, selected)
    if (!isPaneOpen || !key || e.origin?.kind === 'plugin') return next(e)
    const pod = (await read($, pods)).find(p => keyOf(p) === key)
    const note = [
      `Pod selected in the podside pane: context \`${await read($, ctx)}\`, namespace \`${pod?.ns ?? key.split('/')[0]}\`, pod \`${pod?.name ?? key.split('/')[1]}\`.`,
      pod
        ? `Status: ${pod.status}, READY ${pod.ready}, RESTARTS ${pod.restarts}, AGE ${pod.age}, NODE ${pod.node}, IP ${pod.ip}.`
        : 'The pod is not in the latest listing (it may have been deleted).',
      `Open view in the pane: ${await read($, view)}. When the user says "this pod", they mean this one.`,
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // session.start does not fire again after /clear or /resume, so keep the timer
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The mobile surface has no Select or Input; skip those controls there
    const Select = 'Select' in els ? els.Select : undefined
    const Input = 'Input' in els ? els.Input : undefined

    const width = Math.max(56, e.props.bodyColumns ?? 100)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const all = await read($, pods)
    const sel = await read($, selected)
    const mode = await read($, view)
    const context = await read($, ctx)
    const namespace = await read($, ns)
    const err = await read($, error)
    const synced = await read($, syncedAt)
    const query = (await read($, filter)).toLowerCase()
    const isFailingOnly = await read($, onlyFailing)
    const { k8s } = await read($, info)
    const now = await $.clock.now()
    const nsLabel = namespace === ALL ? 'all namespaces' : namespace

    const counts: Record<Health, number> = { ok: 0, warn: 0, bad: 0, done: 0 }
    for (const pod of all) counts[health(pod)] += 1

    const rule = <Text dimColor>{'─'.repeat(width)}</Text>

    // ── Top bar: wordmark, where you are, health totals ───────────────────
    const topBar = (
      <Box justifyContent="space-between">
        <Text>
          <Text color={P.accent} bold>◆ podside</Text>
          <Text dimColor>{'  '}</Text>
          <Text bold>{context || 'kubectl'}</Text>
          <Text dimColor> / </Text>
          <Text bold>{nsLabel}</Text>
          {k8s ? <Text dimColor>{'  '}{k8s}</Text> : null}
        </Text>
        <Text>
          {(['ok', 'warn', 'bad', 'done'] as const).map(state => (
            <Text color={GLYPH[state].color} dimColor={GLYPH[state].dim}>
              {GLYPH[state].mark} {counts[state]}{'  '}
            </Text>
          ))}
          <Text dimColor>
            {err ? 'sync failed' : synced ? `synced ${ago(now, synced)} ago` : 'loading…'}
          </Text>
        </Text>
      </Box>
    )

    // ── Bottom bar: every action, one key each ─────────────────────────────
    const action = (hotkey: string, label: string, onPress: () => void) => (
      <Button key={`do:${hotkey}`} plain hotkey={hotkey} label={label} onPress={onPress} />
    )
    const bottomBar = (
      <Box flexDirection="column">
        {rule}
        <Box gap={2} flexWrap="wrap">
          {mode !== 'list' && action('b', 'back', () => void update($, view, () => 'list'))}
          {action('l', 'logs', () => void loadDetail($, 'logs'))}
          {action('d', 'describe', () => void loadDetail($, 'describe'))}
          {action('a', 'ask Claude', () => void askClaude($))}
          {mode === 'list' &&
            action('f', isFailingOnly ? 'show all' : 'failing only', () =>
              void update($, onlyFailing, v => !v),
            )}
          {mode === 'list' && action('n', 'next namespace', () => void nextNamespace($))}
          {action('r', 'refresh', () => void refreshPods($))}
        </Box>
        {err && <Text color={P.bad}>{fit(err, width)}</Text>}
      </Box>
    )

    // ── Logs / describe ───────────────────────────────────────────────────
    if (mode !== 'list') {
      const raw = (await read($, detail)).split('\n')
      // Logs stay pinned to the newest lines; describe reads from the top
      const room = Math.max(5, bodyRows - 6)
      const lines = mode === 'logs' ? raw.slice(-room) : raw.slice(0, 400)
      return (
        <Box flexDirection="column">
          {topBar}
          <Text>
            <Text color={P.accent}>▌</Text>
            <Text bold> {sel ?? ''}</Text>
            <Text dimColor>
              {'  '}
              {mode === 'logs' ? 'logs · following, newest at the bottom' : 'describe'}
            </Text>
          </Text>
          {rule}
          {lines.map(line => {
            const m = mode === 'describe' ? /^(\s*)([^:]{1,40}:)(.*)$/.exec(line) : null
            return m ? (
              <Text>
                <Text dimColor>{m[1]}{m[2]}</Text>
                <Text>{fit(m[3] ?? '', width - (m[1]?.length ?? 0) - (m[2]?.length ?? 0))}</Text>
              </Text>
            ) : (
              <Text>{fit(line, width)}</Text>
            )
          })}
          {bottomBar}
        </Box>
      )
    }

    // ── Pod list, grouped by namespace ─────────────────────────────────────
    const controls = (
      <Box gap={2}>
        {Select && (await read($, contexts)).length > 1 && (
          <Select
            key="ctx"
            label="context"
            value={context}
            options={(await read($, contexts)).map(c => ({ value: c }))}
            onSelect={(v: string) => {
              void (async () => {
                await update($, ctx, () => v)
                await update($, filter, () => '')
                await setNamespace($, ALL)
                await refreshContexts($)
              })()
            }}
          />
        )}
        {Select && (
          <Select
            key="ns"
            label="namespace"
            value={namespace}
            options={[
              { value: ALL, label: 'all' },
              ...(await read($, namespaces)).map(n => ({ value: n })),
            ]}
            onSelect={(v: string) => void setNamespace($, v)}
          />
        )}
        {Input && (
          <Input
            key="filter"
            label="search"
            placeholder="name or status"
            value={query}
            onInput={(v: string) => void update($, filter, () => v)}
            onSubmit={(v: string) => void update($, filter, () => v)}
          />
        )}
      </Box>
    )

    const list = all.filter(
      p =>
        (!isFailingOnly || !p.isHealthy) &&
        (!query || `${p.ns}/${p.name} ${p.status}`.toLowerCase().includes(query)),
    )
    const shown = list.slice(0, MAX_ROWS)
    const cols = columns(width)
    const [nameCol, ...restCols] = cols
    const cells = (p: Pod) => restCols.map(c => fit(String(p[c.id]), c.width)).join('')

    const rows: any[] = []
    let group = ''
    for (const p of shown) {
      if (namespace === ALL && p.ns !== group) {
        group = p.ns
        const inGroup = list.filter(q => q.ns === group)
        const failing = inGroup.filter(q => !q.isHealthy).length
        rows.push(
          <Box key={`ns:${group}`} marginTop={rows.length > 0 ? 1 : 0}>
            <Text bold>{group}</Text>
            <Text dimColor>
              {'  '}
              {inGroup.length} pods
            </Text>
            {failing > 0 && <Text color={P.bad}>{'  '}{failing} failing</Text>}
          </Box>,
        )
      }
      const key = keyOf(p)
      const isSel = sel === key
      const g = GLYPH[health(p)]
      rows.push(
        <Box key={`row:${key}`}>
          <Text color={P.accent}>{isSel ? '▌' : ' '}</Text>
          <Text color={g.color} dimColor={g.dim}>{g.mark} </Text>
          <Button
            key={`pod:${key}`}
            plain
            label={fit(p.name, nameCol!.width)}
            dimColor={health(p) === 'done'}
            onPress={() => void update($, selected, () => key)}
          />
          <Text bold={isSel} dimColor={!isSel}>{cells(p)}</Text>
        </Box>,
      )
    }

    return (
      <Box flexDirection="column">
        {topBar}
        {controls}
        {rule}
        <Text dimColor>
          {'   '}
          {cols.map(c => fit(c.title, c.width)).join('')}
        </Text>
        {rows}
        {list.length > MAX_ROWS && (
          <Text dimColor>
            {'   '}+{list.length - MAX_ROWS} more · narrow it with namespace, search or f
          </Text>
        )}
        {list.length === 0 && (
          <Text dimColor>
            {'   '}
            {err ? 'kubectl failed, see below' : isFailingOnly ? 'nothing failing' : 'no pods'}
          </Text>
        )}
        {bottomBar}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isActive)) || (await read($, error))) return next(e)
    const list = await read($, pods)
    const bad = list.filter(p => health(p) === 'bad').length
    const ok = list.filter(p => health(p) === 'ok').length
    const namespace = await read($, ns)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Text color={P.accent}>◆</Text>
        <Text dimColor>
          {await read($, ctx)} / {namespace === ALL ? 'all' : namespace}
        </Text>
        <Text color={P.ok}>● {ok}</Text>
        {bad > 0 && <Text color={P.bad}>✕ {bad}</Text>}
        <Button key="open" label="open pane" plain dimColor onPress={() => void openPane($)} />
      </Box>
    )
  })
}
