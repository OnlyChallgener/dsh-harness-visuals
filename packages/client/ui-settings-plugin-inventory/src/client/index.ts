/** Plugin marketplace plus read-only Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import {
  PluginMarketplaceSettingsTab,
  type PluginMarketplaceSettingsTabInjected,
} from './PluginMarketplaceSettingsTab.tsx'
import { desktopMarketplaceApi } from './marketplace-bridge.ts'
import { en, zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type {
  PluginMarketplaceSettingsTabInjected,
  PluginMarketplaceSettingsTabProps,
} from './PluginMarketplaceSettingsTab.tsx'
export type {
  MarketplaceEnvironment,
  MarketplaceMutationResult,
  MarketplacePlugin,
  PluginMarketplaceApi,
} from './marketplace-bridge.ts'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop marketplace and read-only Host plugin inventory copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** Contribute lazy marketplace and inventory tabs to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const inventoryInjected = (): PluginInventorySettingsTabInjected => ({ list })
  const marketplaceInjected = (): PluginMarketplaceSettingsTabInjected => ({ api: desktopMarketplaceApi() })

  // Registration itself only checks whether the preload bridge exists. The
  // marketplace does not invoke IPC until its tab is first mounted.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'marketplace',
    order: 5,
    label: () => t('marketplaceTab'),
    locale: NS,
    inject: marketplaceInjected,
  }, PluginMarketplaceSettingsTab))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: inventoryInjected,
  }, PluginInventorySettingsTab))
}
