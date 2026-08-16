/** Desktop-only bridge for the plugin marketplace. The browser package keeps
 * the Electron preload optional so ordinary Web deployments remain untouched.
 */

export interface MarketplaceEnvironment {
  nodeVersion: string
  pnpmAvailable: boolean
  profile: 'web'
}

export type MarketplacePluginSource = 'npm' | 'github' | 'unknown'
export type MarketplacePluginProvenance = 'deepseek-scope' | 'registry' | 'declared' | 'unknown'
export type MarketplaceUpdateStatus = 'available' | 'current' | 'unavailable' | 'unsupported'

export interface MarketplacePlugin {
  name: string
  version: string
  description?: string
  homepage?: string
  repository?: string
  license?: string
  source?: MarketplacePluginSource
  provenance?: MarketplacePluginProvenance
  latestVersion?: string
  updateAvailable?: boolean
  updateStatus?: MarketplaceUpdateStatus
  updateSpec?: string
}

export interface MarketplaceBuildApproval {
  kind: 'build-scripts'
  packages: string[]
}

export interface MarketplaceMutationResult {
  restartRequired: boolean
  approvalRequired?: MarketplaceBuildApproval
  installed?: string
  installedVersion?: string
  installedNames?: string[]
}

export type MarketplaceJobState = 'running' | 'approval-required' | 'succeeded' | 'failed' | 'cancelled'

export interface MarketplaceInstallerJob {
  id: string
  spec: string
  mode: 'install' | 'update'
  state: MarketplaceJobState
  stage: string
  message: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  approvalRequired?: MarketplaceBuildApproval
  result?: MarketplaceMutationResult
  error?: string
}

type MarketplaceInstallRequest = string | {
  spec: string
  mode: 'install' | 'update'
  approveBuilds?: boolean
}

type MarketplaceJobRequest = {
  spec: string
  mode: 'install' | 'update'
}

export interface PluginMarketplaceApi {
  environment: () => Promise<MarketplaceEnvironment>
  list: () => Promise<MarketplacePlugin[]>
  install: (spec: string, approveBuilds?: boolean) => Promise<MarketplaceMutationResult>
  update: (spec: string, approveBuilds?: boolean) => Promise<MarketplaceMutationResult>
  remove: (name: string) => Promise<MarketplaceMutationResult>
  jobStatus: () => Promise<MarketplaceInstallerJob | undefined>
  cancelJob: (id: string) => Promise<MarketplaceInstallerJob | undefined>
  restart: () => Promise<void>
}

interface DesktopBridge {
  pluginMarketplaceEnvironment?: () => Promise<MarketplaceEnvironment>
  pluginMarketplaceList?: () => Promise<MarketplacePlugin[]>
  pluginMarketplaceInstall?: (request: MarketplaceInstallRequest) => Promise<MarketplaceMutationResult>
  pluginMarketplaceRemove?: (name: string) => Promise<MarketplaceMutationResult>
  pluginMarketplaceJobStart?: (request: MarketplaceJobRequest) => Promise<MarketplaceInstallerJob>
  pluginMarketplaceJobStatus?: () => Promise<MarketplaceInstallerJob | undefined>
  pluginMarketplaceJobApprove?: (id: string) => Promise<MarketplaceInstallerJob>
  pluginMarketplaceJobCancel?: (id: string) => Promise<MarketplaceInstallerJob | undefined>
  restart?: () => Promise<unknown>
}

const JOB_POLL_MS = 350

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

/** Resolve the isolated Electron preload face without declaring a global Window extension. */
export function desktopMarketplaceApi(): PluginMarketplaceApi | undefined {
  const candidate = (globalThis as { desktop?: unknown }).desktop
  if (candidate === null || typeof candidate !== 'object') return undefined
  const desktop = candidate as DesktopBridge
  const environment = desktop.pluginMarketplaceEnvironment
  const list = desktop.pluginMarketplaceList
  const legacyInstall = desktop.pluginMarketplaceInstall
  const remove = desktop.pluginMarketplaceRemove
  const startJob = desktop.pluginMarketplaceJobStart
  const statusJob = desktop.pluginMarketplaceJobStatus
  const approveJob = desktop.pluginMarketplaceJobApprove
  const cancelJob = desktop.pluginMarketplaceJobCancel
  const restart = desktop.restart
  if (typeof environment !== 'function'
    || typeof list !== 'function'
    || typeof remove !== 'function'
    || typeof restart !== 'function') return undefined

  const hasJobRuntime = typeof startJob === 'function'
    && typeof statusJob === 'function'
    && typeof approveJob === 'function'
    && typeof cancelJob === 'function'

  const waitForJob = async (id: string): Promise<MarketplaceMutationResult> => {
    if (!hasJobRuntime) throw new Error('Desktop plugin installer job runtime is unavailable.')
    while (true) {
      const job = await statusJob!()
      if (job === undefined || job.id !== id) throw new Error('Desktop plugin installer lost the active job.')
      if (job.state === 'approval-required') {
        return {
          restartRequired: false,
          ...(job.approvalRequired === undefined ? {} : { approvalRequired: job.approvalRequired }),
        }
      }
      if (job.state === 'succeeded') return job.result ?? { restartRequired: true }
      if (job.state === 'failed') throw new Error(job.error ?? 'Plugin operation failed.')
      if (job.state === 'cancelled') throw new Error('Plugin operation was cancelled.')
      await delay(JOB_POLL_MS)
    }
  }

  const runJob = async (
    spec: string,
    mode: 'install' | 'update',
    approveBuilds: boolean,
  ): Promise<MarketplaceMutationResult> => {
    if (!hasJobRuntime) {
      if (typeof legacyInstall !== 'function') throw new Error('Desktop plugin installer is unavailable.')
      return mode === 'update'
        ? legacyInstall({ spec, mode, ...(approveBuilds ? { approveBuilds: true } : {}) })
        : legacyInstall(approveBuilds ? { spec, mode, approveBuilds: true } : spec)
    }

    const current = await statusJob!()
    if (approveBuilds) {
      if (current === undefined
        || current.spec !== spec
        || current.mode !== mode
        || current.state !== 'approval-required') {
        throw new Error('No matching plugin build approval is pending.')
      }
      const resumed = await approveJob!(current.id)
      return waitForJob(resumed.id)
    }

    if (current !== undefined && (current.state === 'running' || current.state === 'approval-required')) {
      if (current.spec !== spec || current.mode !== mode) {
        throw new Error(`Another plugin operation is already active: ${current.spec}`)
      }
      return waitForJob(current.id)
    }

    const started = await startJob!({ spec, mode })
    return waitForJob(started.id)
  }

  return {
    environment: () => environment(),
    list: () => list(),
    install: (spec, approveBuilds = false) => runJob(spec, 'install', approveBuilds),
    update: (spec, approveBuilds = false) => runJob(spec, 'update', approveBuilds),
    remove: name => remove(name),
    jobStatus: () => hasJobRuntime ? statusJob!() : Promise.resolve(undefined),
    cancelJob: id => hasJobRuntime ? cancelJob!(id) : Promise.resolve(undefined),
    restart: async () => { await restart() },
  }
}
