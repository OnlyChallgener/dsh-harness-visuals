import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopMarketplaceApi, type MarketplaceInstallerJob } from '../src/client/marketplace-bridge.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function terminalJob(request: { spec: string; mode: 'install' | 'update' | 'remove' }): MarketplaceInstallerJob {
  return {
    id: 'job-next',
    spec: request.spec,
    mode: request.mode,
    state: 'succeeded',
    stage: 'complete',
    message: 'done',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: Date.now(),
    result: { restartRequired: true },
  }
}

describe('desktopMarketplaceApi', () => {
  it('cancels an abandoned approval before starting a different explicit operation', async () => {
    let current: MarketplaceInstallerJob = {
      id: 'job-old',
      spec: '@fixture/old-plugin',
      mode: 'install',
      state: 'approval-required',
      stage: 'approval-required',
      message: 'approval needed',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      approvalRequired: { kind: 'build-scripts', packages: ['native-addon'] },
    }
    const cancel = vi.fn(async (_id: string) => {
      current = { ...current, state: 'cancelled', stage: 'cancelled', updatedAt: Date.now() }
      return current
    })
    const start = vi.fn(async (request: { spec: string; mode: 'install' | 'update' | 'remove' }) => {
      current = terminalJob(request)
      return current
    })

    vi.stubGlobal('desktop', {
      pluginMarketplaceEnvironment: vi.fn(async () => ({ nodeVersion: 'v24.18.1', pnpmAvailable: true, profile: 'web' as const })),
      pluginMarketplaceList: vi.fn(async () => []),
      pluginMarketplaceJobStart: start,
      pluginMarketplaceJobStatus: vi.fn(async () => current),
      pluginMarketplaceJobApprove: vi.fn(async () => current),
      pluginMarketplaceJobCancel: cancel,
      restart: vi.fn(async () => undefined),
    })

    const api = desktopMarketplaceApi()
    expect(api).toBeDefined()
    await api!.update('@fixture/new-plugin@2.0.0')

    expect(cancel).toHaveBeenCalledWith('job-old')
    expect(start).toHaveBeenCalledWith({ spec: '@fixture/new-plugin@2.0.0', mode: 'update' })
  })

  it('reattaches to the same approval job instead of starting a duplicate', async () => {
    const current: MarketplaceInstallerJob = {
      id: 'job-same',
      spec: '@fixture/plugin',
      mode: 'install',
      state: 'approval-required',
      stage: 'approval-required',
      message: 'approval needed',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      approvalRequired: { kind: 'build-scripts', packages: ['native-addon'] },
    }
    const start = vi.fn()
    const cancel = vi.fn()

    vi.stubGlobal('desktop', {
      pluginMarketplaceEnvironment: vi.fn(async () => ({ nodeVersion: 'v24.18.1', pnpmAvailable: true, profile: 'web' as const })),
      pluginMarketplaceList: vi.fn(async () => []),
      pluginMarketplaceJobStart: start,
      pluginMarketplaceJobStatus: vi.fn(async () => current),
      pluginMarketplaceJobApprove: vi.fn(async () => current),
      pluginMarketplaceJobCancel: cancel,
      restart: vi.fn(async () => undefined),
    })

    const api = desktopMarketplaceApi()
    const result = await api!.install('@fixture/plugin')

    expect(result.approvalRequired?.packages).toEqual(['native-addon'])
    expect(start).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
})