// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PluginMarketplaceSettingsTab,
  type PluginMarketplaceSettingsTabProps,
} from '../src/client/PluginMarketplaceSettingsTab.tsx'
import type { PluginMarketplaceApi } from '../src/client/marketplace-bridge.ts'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

const catalogFixture = {
  updated: '2026-08-16',
  categories: { ui: { en: 'UI Enhancements', zh: 'UI 增强' } },
  plugins: [{
    name: 'community-plugin',
    owner: 'fixture-owner',
    url: 'https://github.com/fixture-owner/community-plugin',
    category: 'ui',
    description: { en: 'A community plugin fixture', zh: '社区插件测试项' },
    npm: 'community-plugin',
    stars: 42,
    added: '2026-08-16',
    install: 'dsh plugin --profile web add community-plugin',
  }],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(catalogFixture),
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginMarketplaceSettingsTabProps['t']

function props(api: PluginMarketplaceApi | undefined): PluginMarketplaceSettingsTabProps {
  return { t, api } as PluginMarketplaceSettingsTabProps
}

function createApi() {
  const environment = vi.fn<PluginMarketplaceApi['environment']>()
    .mockResolvedValue({ nodeVersion: 'v24.1.0', pnpmAvailable: true, profile: 'web' })
  const list = vi.fn<PluginMarketplaceApi['list']>()
    .mockResolvedValue([{ name: '@fixture/plugin', version: '1.2.3' }])
  const install = vi.fn<PluginMarketplaceApi['install']>()
    .mockResolvedValue({ restartRequired: true })
  const remove = vi.fn<PluginMarketplaceApi['remove']>()
    .mockResolvedValue({ restartRequired: true })
  const restart = vi.fn<PluginMarketplaceApi['restart']>().mockResolvedValue(undefined)
  return { environment, list, install, remove, restart } satisfies PluginMarketplaceApi
}

describe('PluginMarketplaceSettingsTab', () => {
  it('stays desktop-only without a preload bridge', () => {
    render(<PluginMarketplaceSettingsTab {...props(undefined)} />)
    expect(screen.getByText(en.marketplaceDesktopOnlyTitle)).toBeTruthy()
    expect(screen.getByText(en.marketplaceDesktopOnly)).toBeTruthy()
  })

  it('loads only after mount and installs through the injected desktop API', async () => {
    const bridge = createApi()
    render(<PluginMarketplaceSettingsTab {...props(bridge)} />)

    await screen.findByText('@fixture/plugin')
    expect(bridge.environment).toHaveBeenCalledOnce()
    expect(bridge.list).toHaveBeenCalledOnce()
    expect(screen.getByText('Node v24.1.0')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: en.marketplaceRecommended }))
    const input = screen.getByLabelText(en.marketplaceInstallTitle)
    fireEvent.change(input, { target: { value: '@scope/new-plugin@1.0.0' } })
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceInstall }))

    await waitFor(() => {
      expect(bridge.install).toHaveBeenCalledWith('@scope/new-plugin@1.0.0')
    })
    expect(await screen.findByText(en.marketplaceRestartTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceRestart }))
    expect(bridge.restart).toHaveBeenCalledOnce()
  })

  it('installs a validated community-catalog item through the same backend', async () => {
    const bridge = createApi()
    render(<PluginMarketplaceSettingsTab {...props(bridge)} />)
    await screen.findByText('@fixture/plugin')

    fireEvent.click(screen.getByRole('tab', { name: en.marketplaceRecommended }))
    const pluginName = await screen.findByText('community-plugin')
    const card = pluginName.closest('article')
    expect(card).not.toBeNull()
    fireEvent.click(within(card!).getByRole('button', { name: en.marketplaceCatalogInstall }))

    await waitFor(() => { expect(bridge.install).toHaveBeenCalledWith('community-plugin') })
    expect(await screen.findByText(en.marketplaceRestartTitle)).toBeTruthy()
  })

  it('removes an installed package and requests restart without hot reloading', async () => {
    const bridge = createApi()
    render(<PluginMarketplaceSettingsTab {...props(bridge)} />)
    await screen.findByText('@fixture/plugin')

    fireEvent.click(screen.getByRole('button', { name: en.marketplaceRemove }))
    await waitFor(() => { expect(bridge.remove).toHaveBeenCalledWith('@fixture/plugin') })
    await waitFor(() => { expect(screen.queryByText('@fixture/plugin')).toBeNull() })
    expect(screen.getByText(en.marketplaceRestartTitle)).toBeTruthy()
  })

  it('disables mutations when pnpm is unavailable', async () => {
    const bridge = createApi()
    bridge.environment.mockResolvedValue({ nodeVersion: 'v24.1.0', pnpmAvailable: false, profile: 'web' })
    render(<PluginMarketplaceSettingsTab {...props(bridge)} />)

    expect(await screen.findByText(en.marketplacePnpmTitle)).toBeTruthy()
    expect(bridge.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: en.marketplaceRecommended }))
    expect((screen.getByLabelText(en.marketplaceInstallTitle) as HTMLInputElement).disabled).toBe(true)
  })
})
