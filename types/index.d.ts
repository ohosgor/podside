export type Pod = {
  ns: string
  name: string
  ready: string
  status: string
  restarts: string
  age: string
  ip: string
  node: string
  isHealthy: boolean
}

export type View = 'list' | 'logs' | 'describe'

export type ClusterInfo = { cluster: string; user: string; k8s: string }

declare module 'claude-code' {
  interface PluginState {
    podside: {
      pods: Pod[]
      selected: string | null
      view: View
      detail: string
      ctx: string
      contexts: string[]
      ns: string
      namespaces: string[]
      error: string | null
      syncedAt: number
      isActive: boolean
      filter: string
      onlyFailing: boolean
      isHelpOpen: boolean
      info: ClusterInfo
    }
  }
}
