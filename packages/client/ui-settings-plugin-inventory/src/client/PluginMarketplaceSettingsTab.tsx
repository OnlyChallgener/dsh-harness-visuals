/** Desktop plugin marketplace: lazy environment/list reads plus bounded install/remove actions. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import type { MarketplaceEnvironment, MarketplacePlugin, PluginMarketplaceApi } from './marketplace-bridge.ts'
import css from './PluginMarketplaceSettingsTab.module.css'

/** Registration-side Electron marketplace face; absent in ordinary browser deployments. */
export interface PluginMarketplaceSettingsTabInjected {
  api: PluginMarketplaceApi | undefined
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginMarketplaceSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginMarketplaceSettingsTabInjected>

type LoadPhase = 'idle' | 'loading' | 'ready' | 'error'
type MarketView = 'installed' | 'recommended'

const SOURCE_GUIDES = [
  {
    id: 'npm',
    title: 'marketplaceNpmTitle',
    body: 'marketplaceNpmBody',
    syntax: '@scope/plugin@1.2.3',
  },
  {
    id: 'github',
    title: 'marketplaceGithubTitle',
    body: 'marketplaceGithubBody',
    syntax: 'github:owner/repo#tag',
  },
] as const satisfies readonly {
  id: string
  title: PluginInventoryLocaleKey
  body: PluginInventoryLocaleKey
  syntax: string
}[]

/** Render one installed package row. */
function InstalledPlugin({
  plugin,
  disabled,
  busy,
  remove,
  t,
}: {
  plugin: MarketplacePlugin
  disabled: boolean
  busy: boolean
  remove: (name: string) => void
  t: PluginMarketplaceSettingsTabProps['t']
}): ReactNode {
  return (
    <li className={css.pluginCard}>
      <div className={css.pluginIdentity}>
        <strong title={plugin.name}>{plugin.name}</strong>
        <span>{t('marketplaceVersion')} {plugin.version || '—'}</span>
      </div>
      <button
        className={css.dangerButton}
        type="button"
        disabled={disabled}
        onClick={() => { remove(plugin.name) }}
      >
        {busy ? t('marketplaceRemoving') : t('marketplaceRemove')}
      </button>
    </li>
  )
}

/**
 * Marketplace reads are intentionally started only when this tab mounts. The
 * parent Plugins section mounts tabs on first visit, so application startup
 * never probes pnpm or enumerates the profile.
 */
export function PluginMarketplaceSettingsTab({ api, t }: PluginMarketplaceSettingsTabProps): ReactNode {
  const [view, setView] = useState<MarketView>('installed')
  const [phase, setPhase] = useState<LoadPhase>(api === undefined ? 'idle' : 'loading')
  const [environment, setEnvironment] = useState<MarketplaceEnvironment>()
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([])
  const [spec, setSpec] = useState('')
  const [operation, setOperation] = useState<string>()
  const [operationFailed, setOperationFailed] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (api === undefined) return
    setPhase('loading')
    setOperationFailed(false)
    try {
      const nextEnvironment = await api.environment()
      setEnvironment(nextEnvironment)
      if (!nextEnvironment.pnpmAvailable) {
        setPlugins([])
        setPhase('ready')
        return
      }
      setPlugins(await api.list())
      setPhase('ready')
    } catch {
      setPhase('error')
    }
  }, [api])

  useEffect(() => {
    let current = true
    if (api === undefined) return () => { current = false }
    void (async () => {
      try {
        const nextEnvironment = await api.environment()
        if (!current) return
        setEnvironment(nextEnvironment)
        if (!nextEnvironment.pnpmAvailable) {
          setPlugins([])
          setPhase('ready')
          return
        }
        const nextPlugins = await api.list()
        if (!current) return
        setPlugins(nextPlugins)
        setPhase('ready')
      } catch {
        if (current) setPhase('error')
      }
    })()
    return () => { current = false }
  }, [api])

  const install = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const value = spec.trim()
    if (api === undefined || environment?.pnpmAvailable !== true || value.length === 0 || operation !== undefined) return
    setOperation('install')
    setOperationFailed(false)
    try {
      const result = await api.install(value)
      setRestartRequired(current => current || result.restartRequired)
      setSpec('')
      try { setPlugins(await api.list()) } catch { /* install already succeeded; keep the existing snapshot */ }
    } catch {
      setOperationFailed(true)
    } finally {
      setOperation(undefined)
    }
  }

  const remove = (name: string): void => {
    if (api === undefined || environment?.pnpmAvailable !== true || operation !== undefined) return
    setOperation(`remove:${name}`)
    setOperationFailed(false)
    void api.remove(name).then(
      (result) => {
        setRestartRequired(current => current || result.restartRequired)
        setPlugins(current => current.filter(plugin => plugin.name !== name))
      },
      () => { setOperationFailed(true) },
    ).finally(() => { setOperation(undefined) })
  }

  if (api === undefined) {
    return (
      <div className={css.section}>
        <div className={css.notice}>
          <strong>{t('marketplaceDesktopOnlyTitle')}</strong>
          <span>{t('marketplaceDesktopOnly')}</span>
        </div>
      </div>
    )
  }

  const pnpmReady = environment?.pnpmAvailable === true

  return (
    <div className={css.section} aria-busy={phase === 'loading'}>
      <div className={css.hero}>
        <div>
          <h3>{t('marketplaceTitle')}</h3>
          <p>{t('marketplaceIntro')}</p>
        </div>
        {environment !== undefined ? (
          <div className={css.runtimeBadges} aria-label={t('marketplaceEnvironment')}>
            <span>Node {environment.nodeVersion}</span>
            <span data-ready={environment.pnpmAvailable ? 'true' : 'false'}>
              pnpm {environment.pnpmAvailable ? t('marketplaceReady') : t('marketplaceMissing')}
            </span>
          </div>
        ) : null}
      </div>

      <div className={css.viewTabs} role="tablist" aria-label={t('marketplaceViews')}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'installed'}
          data-active={view === 'installed' ? 'true' : undefined}
          onClick={() => { setView('installed') }}
        >
          {t('marketplaceInstalled')} {plugins.length > 0 ? `(${plugins.length})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'recommended'}
          data-active={view === 'recommended' ? 'true' : undefined}
          onClick={() => { setView('recommended') }}
        >
          {t('marketplaceRecommended')}
        </button>
      </div>

      {phase === 'loading' ? <p className={css.status}>{t('marketplaceLoading')}</p> : null}
      {phase === 'error' ? (
        <div className={css.failure}>
          <span role="alert">{t('marketplaceLoadError')}</span>
          <button type="button" onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      ) : null}

      {phase === 'ready' && !pnpmReady ? (
        <div className={css.warning} role="status">
          <strong>{t('marketplacePnpmTitle')}</strong>
          <span>{t('marketplacePnpmMissing')}</span>
        </div>
      ) : null}

      {operationFailed ? <p className={css.operationError} role="alert">{t('marketplaceOperationError')}</p> : null}

      {phase === 'ready' && view === 'installed' ? (
        <div className={css.marketBody}>
          <div className={css.bodyHeader}>
            <div>
              <strong>{t('marketplaceInstalledTitle')}</strong>
              <span>{t('marketplaceInstalledHint')}</span>
            </div>
            <button
              className={css.secondaryButton}
              type="button"
              disabled={!pnpmReady || operation !== undefined}
              onClick={() => { void load() }}
            >
              {t('marketplaceRefresh')}
            </button>
          </div>
          {pnpmReady && plugins.length === 0 ? <p className={css.status}>{t('marketplaceEmpty')}</p> : null}
          {pnpmReady && plugins.length > 0 ? (
            <ul className={css.pluginList}>
              {plugins.map(plugin => (
                <InstalledPlugin
                  key={plugin.name}
                  plugin={plugin}
                  disabled={operation !== undefined}
                  busy={operation === `remove:${plugin.name}`}
                  remove={remove}
                  t={t}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {phase === 'ready' && view === 'recommended' ? (
        <div className={css.marketBody}>
          <div className={css.sourceGrid}>
            {SOURCE_GUIDES.map(source => (
              <article className={css.sourceCard} key={source.id}>
                <strong>{t(source.title)}</strong>
                <p>{t(source.body)}</p>
                <code>{source.syntax}</code>
              </article>
            ))}
          </div>
          <p className={css.trustNote}>{t('marketplaceTrustNote')}</p>
          <form className={css.installForm} onSubmit={(event) => { void install(event) }}>
            <label htmlFor="plugin-marketplace-spec">{t('marketplaceInstallTitle')}</label>
            <div className={css.installControls}>
              <input
                id="plugin-marketplace-spec"
                value={spec}
                disabled={!pnpmReady || operation !== undefined}
                placeholder={t('marketplaceInstallPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => { setSpec(event.currentTarget.value) }}
              />
              <button
                className={css.primaryButton}
                type="submit"
                disabled={!pnpmReady || operation !== undefined || spec.trim().length === 0}
              >
                {operation === 'install' ? t('marketplaceInstalling') : t('marketplaceInstall')}
              </button>
            </div>
            <span>{t('marketplaceInstallHint')}</span>
          </form>
        </div>
      ) : null}

      {restartRequired ? (
        <div className={css.restartBanner} role="status">
          <div>
            <strong>{t('marketplaceRestartTitle')}</strong>
            <span>{t('marketplaceRestartHint')}</span>
          </div>
          <button
            className={css.primaryButton}
            type="button"
            disabled={operation !== undefined}
            onClick={() => { void api.restart() }}
          >
            {t('marketplaceRestart')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
