import { expect, test } from 'claude-code/testing'

const PODS_ALL = [
  'argocd   argocd-application-controller-0   1/1   Running   13 (34h ago)   4d18h   10.0.0.4   orbstack   <none>   <none>',
  'argocd   argocd-applicationset-controller-6f44-2dhj8   0/1   ContainerStatusUnknown   0   4d18h   <none>   orbstack   <none>   <none>',
  'default  web-7d9f   1/1   Running   0   2h   10.0.0.5   orbstack   <none>   <none>',
  'jobs     migrate-xk2   0/1   Completed   0   1d   <none>   orbstack   <none>   <none>',
].join('\n')

function fakeKubectl(argv: readonly string[]) {
  const args = argv.join(' ')
  const out = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  if (args.includes('get-contexts')) return out('orbstack\ndocker-desktop\n')
  if (args.includes('current-context')) return out('orbstack\n')
  if (args.includes('get ns')) return out('argocd default jobs kube-system')
  if (args.includes('config view')) return out('orbstack orbstack')
  if (args.includes('version')) return out('{"serverVersion":{"gitVersion":"v1.35.6"}}')
  if (args.includes('get pods')) return out(PODS_ALL)
  if (args.includes('describe')) return out('Name:  web-7d9f\nStatus:  Running\nEvents: <none>')
  if (args.includes('logs')) return out('line 1\nline 2')
  return { exitCode: 1, stdout: '', stderr: 'unexpected' }
}

const paneProps = (bodyColumns: number) => ({
  title: 'k9s',
  isFocused: true,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 } as any,
  view: {},
})

test('the pod table, detail views and band draw on every surface', { timeoutMs: 20_000 }, async ($, on) => {
  on('process.run', async (_$, e) => ({ value: fakeKubectl(e.argv) }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as any)
  on('clock.now', async () => ({ value: 1_000_000 }) as any)
  on('ui.toast', async () => ({ value: undefined }) as any)
  on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.panes', async () => ({ value: [] }) as any)
  on('command.register', async () => ({ value: undefined }) as any)
  on('prompt.submit', async () => ({ value: {} }) as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [80, 160]) {
      const ui = await $.ui.mount({
        plugin: 'podside',
        surface,
        component: 'Pane',
        requestId: 'podside',
        props: paneProps(width) as any,
      })
      await ui.press({ key: 'do:r' })
      expect(await ui.find({ type: 'Text', text: /podside/ })).toBeDefined()
      expect(await ui.find({ key: 'pod:default/web-7d9f' })).toBeDefined()

      await ui.press({ key: 'pod:default/web-7d9f' })
      await ui.press({ key: 'do:d' })
      expect(await ui.find({ type: 'Text', text: /describe/ })).toBeDefined()
      await ui.press({ key: 'do:l' })
      expect(await ui.find({ type: 'Text', text: /line 2/ })).toBeDefined()
      await ui.press({ key: 'do:b' })
      await ui.unmount()
    }

    const band = await $.ui.mount({
      plugin: 'podside',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } as any,
    })
    await band.unmount()
  }
})
