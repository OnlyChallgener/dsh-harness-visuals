/** Searchable community plugin catalog shown only inside the Recommended marketplace view. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PluginInventoryLocaleKey } from './locales.ts'
import type { MarketplacePlugin } from './marketplace-bridge.ts'
import {
  catalogPluginInstalled,
  filterMarketplaceCatalog,
  loadMarketplaceCatalog,
  type MarketplaceCatalog,
  type MarketplaceCatalogPlugin,
  type MarketplaceCatalogSort,
} from './marketplace-catalog.ts'
import css from './MarketplaceCatalogPanel.module.css'

const PAGE_SIZE = 20

type Translate = (key: PluginInventoryLocaleKey) => string

export interface MarketplaceCatalogPanelProps {
  installed: MarketplacePlugin[]
  pnpmReady: boolean
  disabled: boolean
  operation: string | undefined
  onInstall: (spec: string, id: string) => void
  t: Translate
}

type CatalogPhase = 'loading' | 'ready' | 'error'

function localizedText(value: { en?: string; zh?: string } | undefined, language: 'en' | 'zh'): string | undefined {
  if (value === undefined) return undefined
  return value[language] ?? value.en ?? value.zh
}

function categoryLabel(catalog: MarketplaceCatalog, category: string, language: 'en' | 'zh'): string {
  return localizedText(catalog.categories[category], language) ?? category
}

function CatalogCard({
  plugin,
  catalog,
  language,
  installed,
  disabled,
  installing,
  onInstall,
  t,
}: {
  plugin: MarketplaceCatalogPlugin
  catalog: MarketplaceCatalog
  language: 'en' | 'zh'
  installed: boolean
  disabled: boolean
  installing: boolean
  onInstall: () => void
  t: Translate
}): ReactNode {
  const description = localizedText(plugin.description, language) ?? t('marketplaceCatalogNoDescription')
  return (
    <article className={css.card}>
      <div className={css.cardTop}>
        <div className={css.identity}>
          <strong title={plugin.name}>{plugin.name}</strong>
          <span>{t('marketplaceCatalogBy')} {plugin.owner}</span>
        </div>
        <span className={css.category}>{categoryLabel(catalog, plugin.category, language)}</span>
      </div>
      <p className={css.description}>{description}</p>
      <div className={css.cardMeta}>
        {plugin.stars !== undefined ? <span>★ {plugin.stars}</span> : null}
        {plugin.added !== undefined ? <span>{t('marketplaceCatalogAdded')} {plugin.added}</span> : null}
        {plugin.npm !== undefined ? <span>npm</span> : <span>GitHub</span>}
      </div>
      <div className={css.cardFooter}>
        <a className={css.repository} href={plugin.repository} target="_blank" rel="noreferrer">
          {t('marketplaceRepository')}
        </a>
        {installed ? (
          <button className={css.installedButton} type="button" disabled>
            {t('marketplaceCatalogInstalled')}
          </button>
        ) : (
          <button
            className={css.installButton}
            type="button"
            disabled={disabled}
            onClick={onInstall}
          >
            {installing ? t('marketplaceCatalogInstalling') : t('marketplaceCatalogInstall')}
          </button>
        )}
      </div>
    </article>
  )
}

export function MarketplaceCatalogPanel({
  installed,
  pnpmReady,
  disabled,
  operation,
  onInstall,
  t,
}: MarketplaceCatalogPanelProps): ReactNode {
  const [phase, setPhase] = useState<CatalogPhase>('loading')
  const [catalog, setCatalog] = useState<MarketplaceCatalog>()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<MarketplaceCatalogSort>('stars-desc')
  const [page, setPage] = useState(1)
  const language: 'en' | 'zh' = t('marketplaceCatalogLanguage') === 'zh' ? 'zh' : 'en'

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      setCatalog(await loadMarketplaceCatalog())
      setPhase('ready')
    } catch {
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    let current = true
    void loadMarketplaceCatalog().then(
      value => {
        if (!current) return
        setCatalog(value)
        setPhase('ready')
      },
      () => {
        if (current) setPhase('error')
      },
    )
    return () => { current = false }
  }, [])

  useEffect(() => { setPage(1) }, [query, category, sort])

  const visible = useMemo(() => catalog === undefined
    ? []
    : filterMarketplaceCatalog(catalog.plugins, { query, category, sort }), [catalog, query, category, sort])
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pagePlugins = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const categories = useMemo(() => catalog === undefined
    ? []
    : Object.keys(catalog.categories)
      .filter(id => catalog.plugins.some(plugin => plugin.category === id))
      .sort((left, right) => categoryLabel(catalog, left, language).localeCompare(categoryLabel(catalog, right, language))),
  [catalog, language])

  return (
    <section className={css.panel} aria-busy={phase === 'loading'}>
      <div className={css.header}>
        <div className={css.headerText}>
          <strong>{t('marketplaceCatalogTitle')}</strong>
          <span>{t('marketplaceCatalogIntro')}</span>
        </div>
        {catalog?.updated !== undefined ? (
          <span className={css.catalogMeta}>{t('marketplaceCatalogUpdated')} {catalog.updated}</span>
        ) : null}
      </div>

      {phase === 'loading' ? <p className={css.empty}>{t('marketplaceCatalogLoading')}</p> : null}
      {phase === 'error' ? (
        <div className={css.errorRow}>
          <span role="alert">{t('marketplaceCatalogError')}</span>
          <button type="button" onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      ) : null}

      {phase === 'ready' && catalog !== undefined ? (
        <>
          <div className={css.toolbar}>
            <input
              type="search"
              value={query}
              placeholder={t('marketplaceCatalogSearch')}
              aria-label={t('marketplaceCatalogSearch')}
              onChange={event => { setQuery(event.currentTarget.value) }}
            />
            <select
              value={category}
              aria-label={t('marketplaceCatalogCategory')}
              onChange={event => { setCategory(event.currentTarget.value) }}
            >
              <option value="all">{t('marketplaceCatalogAllCategories')}</option>
              {categories.map(id => <option key={id} value={id}>{categoryLabel(catalog, id, language)}</option>)}
            </select>
            <select
              value={sort}
              aria-label={t('marketplaceCatalogSort')}
              onChange={event => { setSort(event.currentTarget.value as MarketplaceCatalogSort) }}
            >
              <option value="stars-desc">{t('marketplaceCatalogPopular')}</option>
              <option value="added-desc">{t('marketplaceCatalogNewest')}</option>
            </select>
          </div>

          <div className={css.statusRow}>
            <span className={css.catalogMeta}>{visible.length} {t('marketplaceCatalogResults')}</span>
            <span className={css.catalogMeta}>{t('marketplaceCatalogCommunity')}</span>
          </div>

          {pagePlugins.length === 0 ? <p className={css.empty}>{t('marketplaceCatalogEmpty')}</p> : (
            <div className={css.grid}>
              {pagePlugins.map(plugin => {
                const isInstalled = catalogPluginInstalled(plugin, installed)
                return (
                  <CatalogCard
                    key={plugin.id}
                    plugin={plugin}
                    catalog={catalog}
                    language={language}
                    installed={isInstalled}
                    disabled={disabled || !pnpmReady}
                    installing={operation === `catalog:${plugin.id}`}
                    onInstall={() => { onInstall(plugin.installSpec, plugin.id) }}
                    t={t}
                  />
                )
              })}
            </div>
          )}

          {pageCount > 1 ? (
            <div className={css.pager}>
              <span>{currentPage} / {pageCount}</span>
              <div className={css.pagerControls}>
                <button type="button" disabled={currentPage <= 1} onClick={() => { setPage(value => Math.max(1, value - 1)) }}>
                  {t('marketplaceCatalogPrevious')}
                </button>
                <button type="button" disabled={currentPage >= pageCount} onClick={() => { setPage(value => Math.min(pageCount, value + 1)) }}>
                  {t('marketplaceCatalogNext')}
                </button>
              </div>
            </div>
          ) : null}

          <p className={css.safetyNote}>{t('marketplaceCatalogSafety')}</p>
        </>
      ) : null}
    </section>
  )
}
