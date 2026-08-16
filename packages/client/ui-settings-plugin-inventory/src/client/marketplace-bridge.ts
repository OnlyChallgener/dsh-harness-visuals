/** Desktop-only bridge for the plugin marketplace. The browser package keeps
 * the Electron preload optional so ordinary Web deployments remain untouched.
 */

export interface MarketplaceEnvironment {
  nodeVersion: string
  pnpmAvailable: boolean
  profile: 'web'
}

export interface MarketplacePlugin {
  name: string
  version: string
  path?: string
}

export interface MarketplaceMutationResult {
  restartRequired: boolean
}

export interface PluginMarketplaceApi {
  environment: () => Promise<MarketplaceEnvironment>
  list: () => Promise<MarketplacePlugin[]>
  install: (spec: string) => Promise<MarketplaceMutationResult>
  remove: (name: string) => Promise<MarketplaceMutationResult>
  restart: () => Promise<void>
}

interface DesktopBridge {
  pluginMarketplaceEnvironment?: () => Promise<MarketplaceEnvironment>
  pluginMarketplaceList?: () => Promise<MarketplacePlugin[]>
  pluginMarketplaceInstall?: (spec: string) => Promise<MarketplaceMutationResult>
  pluginMarketplaceRemove?: (name: string) => Promise<MarketplaceMutationResult>
  restart?: () => Promise<unknown>
}

/** Resolve the isolated Electron preload face without declaring a global Window extension. */
export function desktopMarketplaceApi(): PluginMarketplaceApi | undefined {
  const candidate = (globalThis as { desktop?: unknown }).desktop
  if (candidate === null || typeof candidate !== 'object') return undefined
  const desktop = candidate as DesktopBridge
  const environment = desktop.pluginMarketplaceEnvironment
  const list = desktop.pluginMarketplaceList
  const install = desktop.pluginMarketplaceInstall
  const remove = desktop.pluginMarketplaceRemove
  const restart = desktop.restart
  if (typeof environment !== 'function'
    || typeof list !== 'function'
    || typeof install !== 'function'
    || typeof remove !== 'function'
    || typeof restart !== 'function') return undefined

  return {
    environment: () => environment(),
    list: () => list(),
    install: spec => install(spec),
    remove: name => remove(name),
    restart: async () => { await restart() },
  }
}
