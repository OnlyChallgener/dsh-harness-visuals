import { describe, expect, it } from 'vitest'
import {
  catalogInstallSpec,
  catalogPluginInstalled,
  filterMarketplaceCatalog,
  normalizeMarketplaceCatalog,
} from '../src/client/marketplace-catalog.ts'

describe('marketplace community catalog', () => {
  const registry = {
    updated: '2026-08-16',
    categories: {
      ui: { en: 'UI Enhancements', zh: 'UI 增强' },
      tools: { en: 'Tools', zh: '工具' },
    },
    plugins: [
      {
        name: 'dsh-message-rail',
        owner: 'wx-yss',
        url: 'https://github.com/wx-yss/dsh-message-rail',
        category: 'ui',
        description: { en: 'Message navigation', zh: '消息导航' },
        npm: 'dsh-message-rail',
        stars: 12,
        added: '2026-08-15',
        install: 'dsh plugin --profile web add dsh-message-rail',
      },
      {
        name: 'toolbox',
        owner: 'safe-owner',
        url: 'https://github.com/safe-owner/toolbox',
        category: 'tools',
        description: { en: 'Tool collection' },
        stars: 3,
        added: '2026-08-16',
        install: 'dsh plugin --profile web add github:safe-owner/toolbox',
      },
      {
        name: 'unsafe',
        owner: 'bad-owner',
        url: 'https://github.com/bad-owner/unsafe',
        category: 'tools',
        description: { en: 'Should be removed' },
        install: 'dsh plugin --profile web add safe-package && calc',
      },
      {
        name: 'spoofed-card',
        owner: 'trusted-owner',
        url: 'https://github.com/trusted-owner/spoofed-card',
        category: 'tools',
        description: { en: 'Displayed source and install target disagree' },
        install: 'dsh plugin --profile web add github:other-owner/other-repo',
      },
    ],
  }

  it('keeps only bounded entries whose displayed source and install target agree', () => {
    const catalog = normalizeMarketplaceCatalog(registry)
    expect(catalog.plugins).toHaveLength(2)
    expect(catalog.plugins.map(plugin => plugin.installSpec)).toEqual([
      'dsh-message-rail',
      'github:safe-owner/toolbox',
    ])
    expect(catalogInstallSpec('dsh plugin --profile web add file:../plugin')).toBeUndefined()
    expect(catalogInstallSpec('dsh plugin --profile web add plugin&calc')).toBeUndefined()
  })

  it('filters by category/search and sorts by popularity or recency', () => {
    const catalog = normalizeMarketplaceCatalog(registry)
    expect(filterMarketplaceCatalog(catalog.plugins, {
      query: 'message',
      category: 'all',
      sort: 'stars-desc',
    }).map(plugin => plugin.name)).toEqual(['dsh-message-rail'])
    expect(filterMarketplaceCatalog(catalog.plugins, {
      query: '',
      category: 'all',
      sort: 'added-desc',
    }).map(plugin => plugin.name)).toEqual(['toolbox', 'dsh-message-rail'])
  })

  it('links catalog rows to installed packages by exact npm name or repository identity', () => {
    const catalog = normalizeMarketplaceCatalog(registry)
    expect(catalogPluginInstalled(catalog.plugins[0]!, [{ name: 'dsh-message-rail' }])).toBe(true)
    expect(catalogPluginInstalled(catalog.plugins[1]!, [{
      name: 'different-package-name',
      repository: 'https://github.com/safe-owner/toolbox',
    }])).toBe(true)
    expect(catalogPluginInstalled(catalog.plugins[1]!, [{ name: 'toolbox-pro' }])).toBe(false)
  })
})
