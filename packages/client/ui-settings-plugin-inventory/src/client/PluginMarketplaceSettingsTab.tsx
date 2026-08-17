/** Desktop plugin marketplace: lazy environment/list reads plus bounded install/remove/update actions. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import { MarketplaceCatalogPanel } from './MarketplaceCatalogPanel.tsx'
import type {
  MarketplaceEnvironment,
  MarketplaceInstallerJob,
  MarketplaceMutationResult,
  MarketplacePlugin,
  MarketplacePluginProvenance,
  MarketplacePluginSource,
  MarketplaceUpdateStatus,
  PluginMarketplaceApi,
} from './marketplace-bridge.ts'
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

function sourceLocale(source: MarketplacePluginSource | undefined): PluginInventoryLocaleKey {
  if (source === 'npm') return 'marketplaceSourceNpm'
  if (source === 'github') return 'marketplaceSourceGithub'
  return 'marketplaceSourceUnknown'
}

function provenanceLocale(provenance: MarketplacePluginProvenance | undefined): PluginInventoryLocaleKey {
  if (provenance === 'deepseek-scope') return 'marketplaceProvenanceDeepSeek'
  if (provenance === 'registry') return 'marketplaceProvenanceRegistry'
  if (provenance === 'declared') return 'marketplaceProvenanceDeclared'
  return 'marketplaceProvenanceUnknown'
}

function updateLocale(status: MarketplaceUpdateStatus | undefined): PluginInventoryLocaleKey {
  if (status === 'available') return 'marketplaceUpdateAvailable'
  if (status === 'current') return 'marketplaceUpToDate'
  if (status === 'unavailable') return 'marketplaceUpdateUnknown'
  return 'marketplaceUpdateManual'
}

function hostJobLocale(job: MarketplaceInstallerJob): PluginInventoryLocaleKey {
  if (job.mode === 'update') return 'marketplaceUpdating'
  if (job.mode === 'remove') return 'marketplaceRemoving'
  return 'marketplaceInstalling'
}

function operationErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0) return 'Unknown plugin operation error.'
  return normalized.length > 1_200 ? `${normalized.slice(0, 1_197)}...` : normalized
}

async function mutationWithBuildApproval(
  api: PluginMarketplaceApi,
  run: (approveBuilds: boolean) => Promise<MarketplaceMutationResult>,
  t: PluginMarketplaceSettingsTabProps['t'],
): Promise<MarketplaceMutationResult | undefined> {
  let result = await run(false)
  const packages = result.approvalRequired?.packages ?? []
  if (packages.length === 0) return result
  const approved = globalThis.confirm(
    `${t('marketplaceBuildApprovalTitle')}\n\n${t('marketplaceBuildApprovalBody')}\n\n${packages.map(name => `• ${name}`).join('\n')}`,
  )
  if (!approved) {
    const pending = await api.jobStatus?.().catch(() => undefined)
    if (pending?.state === 'approval-required') await api.cancelJob?.(pending.id).catch(() => undefined)
    return undefined
  }
  result = await run(true)
  if (result.approvalRequired !== undefined) {
    const pending = await api.jobStatus?.().catch(() => undefined)
    if (pending?.state === 'approval-required') await api.cancelJob?.(pending.id).catch(() => undefined)
    throw new Error(t('marketplaceBuildApprovalRetryFailed'))
  }
  return result
}

/** Render one installed package row with local details and update evidence. */
function InstalledPlugin({
  plugin,
  disabled,
  operation,
  update,
  remove,
  t,
}: {
  plugin: MarketplacePlugin
  disabled: boolean
  operation: string | undefined
  update: (plugin: MarketplacePlugin) => void
  remove: (name: string) => void
  t: PluginMarketplaceSettingsTabProps['t']
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const updating = operation === `update:${plugin.name}`
  const removing = operation === `remove:${plugin.name}`
  const canUpdate = plugin.updateAvailable === true && plugin.updateSpec !== undefined

  return (
    <li className={css.pluginCard}>
      <div className={css.pluginSummary}>
        <div className={css.pluginIdentity}>
          <strong title={plugin.name}>{plugin.name}</strong>
          <span>{t('marketplaceVersion')} {plugin.version || '—'}</span>
        </div>
        <div className={css.badges} aria-label={`${plugin.name} metadata`}>
          <span>{t(sourceLocale(plugin.source))}</span>
          <span data-provenance={plugin.provenance ?? 'unknown'}>{t(provenanceLocale(plugin.provenance))}</span>
          <span data-update={plugin.updateStatus ?? 'unavailable'}>{t(updateLocale(plugin.updateStatus))}</span>
        </div>
      </div>

      {expanded ? (
        <div className={css.pluginDetails}>
          <p className={css.description}>{plugin.description ?? t('marketplaceNoDescription')}</p>
          <dl>
            <div>
              <dt>{t('marketplaceSource')}</dt>
              <dd>{t(sourceLocale(plugin.source))}</dd>
            </div>
            <div>
              <dt>{t('marketplaceProvenance')}</dt>
              <dd>{t(provenanceLocale(plugin.provenance))}</dd>
            </div>
            <div>
              <dt>{t('marketplaceLatestVersion')}</dt>
              <dd>{plugin.latestVersion ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('marketplaceLicense')}</dt>
              <dd>{plugin.license ?? '—'}</dd>
            </div>
          </dl>
          {plugin.repository !== undefined || plugin.homepage !== undefined ? (
            <div className={css.pluginLinks}>
              {plugin.repository !== undefined ? (
                <a href={plugin.repository} target="_blank" rel="noreferrer">{t('marketplaceRepository')}</a>
              ) : null}
              {plugin.homepage !== undefined ? (
                <a href={plugin.homepage} target="_blank" rel="noreferrer">{t('marketplaceHomepage')}</a>
              ) : null}
            </div>
          ) : null}
          <p className={css.provenanceNote}>{t('marketplaceProvenanceNote')}</p>
        </div>
      ) : null}

      <div className={css.pluginActions}>
        <button
          className={css.secondaryButton}
          type="button"
          aria-expanded={expanded}
          onClick={() => { setExpanded(current => !current) }}
        >
          {expanded ? t('marketplaceHideDetails') : t('marketplaceDetails')}
        </button>
        {canUpdate ? (
          <button
            className={css.primaryButton}
            type="button"
            disabled={disabled}
            onClick={() => { update(plugin) }}
          >
            {updating ? t('marketplaceUpdating') : t('marketplaceUpdate')}
          </button>
        ) : null}
        <button
          className={css.dangerButton}
          type="button"
          disabled={disabled}
          onClick={() => { remove(plugin.name) }}
        >
          {removing ? t('marketplaceRemoving') : t('marketplaceRemove')}
        </button>
      </div>
    </li>
  )
}

/** Marketplace work starts only when the Settings tab mounts. */
export function PluginMarketplaceSettingsTab({ api, t }: PluginMarketplaceSettingsTabProps): ReactNode {
  const [view, setView] = useState<MarketView>('installed')
  const [phase, setPhase] = useState<LoadPhase>(api === undefined ? 'idle' : 'loading')
  const [environment, setEnvironment] = useState<MarketplaceEnvironment>()
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([])
  const [spec, setSpec] = useState('')
  const [operation, setOperation] = useState<string>()
  const [hostJob, setHostJob] = useState<MarketplaceInstallerJob>()
  const [operationError, setOperationError] = useState<string>()
  const [refreshError, setRefreshError] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (api === undefined) return
    setPhase(current => current === 'ready' ? 'ready' : 'loading')
    setOperationError(undefined)
    setRefreshError(false)
    const [environmentResult, listResult] = await Promise.allSettled([
      api.environment(),
      api.list(),
    ])
    if (environmentResult.status === 'fulfilled') setEnvironment(environmentResult.value)
    if (listResult.status === 'fulfilled') {
      setPlugins(listResult.value)
      setPhase('ready')
      return
    }
    setRefreshError(true)
    setPhase(current => current === 'ready' ? 'ready' : 'error')
  }, [api])

  useEffect(() => {
    let current = true
    if (api === undefined) return () => { current = false }
    void (async () => {
      const [environmentResult, listResult] = await Promise.allSettled([
        api.environment(),
        api.list(),
      ])
      if (!current) return
      if (environmentResult.status === 'fulfilled') setEnvironment(environmentResult.value)
      if (listResult.status === 'fulfilled') {
        setPlugins(listResult.value)
        setRefreshError(false)
        setPhase('ready')
      } else {
        setPhase('error')
      }
    })()
    return () => { current = false }
  }, [api])

  useEffect(() => {
    if (api?.jobStatus === undefined) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let observedActiveJob = false

    const poll = async (): Promise<void> => {
      try {
        const job = await api.jobStatus!()
        if (!current) return

        if (job?.state === 'approval-required' && operation === undefined) {
          // Approval prompts belong to the page that requested them. If that
          // page was left before the decision, there is no package process to
          // preserve, so release the orphan instead of blocking the market.
          await api.cancelJob?.(job.id).catch(() => undefined)
          if (!current) return
          setHostJob(undefined)
          return
        }

        if (job?.state === 'running' || job?.state === 'approval-required') {
          observedActiveJob = true
          setHostJob(job)
          timer = setTimeout(() => { void poll() }, 400)
          return
        }

        setHostJob(undefined)
        if (!observedActiveJob || job === undefined) return
        if (job.state === 'succeeded') {
          setRestartRequired(value => value || job.result?.restartRequired === true)
          try { setPlugins(await api.list()) } catch { /* keep the existing local snapshot */ }
        } else if (job.state === 'failed') {
          setOperationError(operationErrorDetail(job.error ?? job.message))
        }
      } catch {
        if (current && observedActiveJob) timer = setTimeout(() => { void poll() }, 1_000)
      }
    }

    void poll()
    return () => {
      current = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, operation])

  const hostBusy = hostJob?.state === 'running' || hostJob?.state === 'approval-required'
  const busy = operation !== undefined || hostBusy

  const install = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const value = spec.trim()
    if (api === undefined || environment?.pnpmAvailable !== true || value.length === 0 || busy) return
    setOperation('install')
    setOperationError(undefined)
    try {
      const result = await mutationWithBuildApproval(api, approve => api.install(value, approve), t)
      if (result === undefined) return
      setRestartRequired(current => current || result.restartRequired)
      setSpec('')
      try { setPlugins(await api.list()) } catch { /* install already succeeded; keep the existing snapshot */ }
    } catch (error) {
      setOperationError(operationErrorDetail(error))
    } finally {
      setOperation(undefined)
    }
  }

  const installCatalog = (value: string, id: string): void => {
    if (api === undefined || environment?.pnpmAvailable !== true || busy) return
    setOperation(`catalog:${id}`)
    setOperationError(undefined)
    void mutationWithBuildApproval(api, approve => api.install(value, approve), t).then(
      async (result) => {
        if (result === undefined) return
        setRestartRequired(current => current || result.restartRequired)
        try { setPlugins(await api.list()) } catch { /* catalog install succeeded; keep the existing snapshot */ }
      },
      (error) => { setOperationError(operationErrorDetail(error)) },
    ).finally(() => { setOperation(undefined) })
  }

  const update = (plugin: MarketplacePlugin): void => {
    if (api === undefined || environment?.pnpmAvailable !== true || busy || plugin.updateSpec === undefined) return
    setOperation(`update:${plugin.name}`)
    setOperationError(undefined)
    void mutationWithBuildApproval(api, approve => api.update(plugin.updateSpec!, approve), t).then(
      async (result) => {
        if (result === undefined) return
        setRestartRequired(current => current || result.restartRequired)
        const appliedVersion = plugin.latestVersion
        if (appliedVersion !== undefined) {
          setPlugins(current => current.map(item => item.name === plugin.name
            ? { ...item, version: appliedVersion, latestVersion: appliedVersion, updateAvailable: false, updateStatus: 'current' }
            : item))
        }
        try { setPlugins(await api.list()) } catch { /* exact update was verified by Desktop; preserve optimistic version */ }
      },
      (error) => { setOperationError(operationErrorDetail(error)) },
    ).finally(() => { setOperation(undefined) })
  }

  const remove = (name: string): void => {
    if (api === undefined || environment?.pnpmAvailable !== true || busy) return
    setOperation(`remove:${name}`)
    setOperationError(undefined)
    void api.remove(name).then(
      (result) => {
        setRestartRequired(current => current || result.restartRequired)
        setPlugins(current => current.filter(plugin => plugin.name !== name))
      },
      (error) => { setOperationError(operationErrorDetail(error)) },
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
    <div className={css.section} aria-busy={phase === 'loading' || busy}>
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
      {phase === 'ready' && refreshError ? (
        <div className={css.warning} role="status">
          <span>{t('marketplaceLoadError')}</span>
          <button type="button" onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      ) : null}

      {phase === 'ready' && environment !== undefined && !pnpmReady ? (
        <div className={css.warning} role="status">
          <strong>{t('marketplacePnpmTitle')}</strong>
          <span>{t('marketplacePnpmMissing')}</span>
        </div>
      ) : null}

      {hostBusy && operation === undefined && hostJob !== undefined ? (
        <div className={css.warning} role="status">
          <strong>{t(hostJobLocale(hostJob))}</strong>
          <span>{hostJob.spec}</span>
        </div>
      ) : null}

      {operationError !== undefined ? (
        <p className={css.operationError} role="alert">
          {t('marketplaceOperationError')} {' '}{operationError}
        </p>
      ) : null}

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
              disabled={busy}
              onClick={() => { void load() }}
            >
              {t('marketplaceRefresh')}
            </button>
          </div>
          {plugins.length === 0 ? <p className={css.status}>{t('marketplaceEmpty')}</p> : null}
          {plugins.length > 0 ? (
            <ul className={css.pluginList}>
              {plugins.map(plugin => (
                <InstalledPlugin
                  key={plugin.name}
                  plugin={plugin}
                  disabled={!pnpmReady || busy}
                  operation={operation}
                  update={update}
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
          <MarketplaceCatalogPanel
            installed={plugins}
            pnpmReady={pnpmReady}
            disabled={busy}
            operation={operation}
            onInstall={installCatalog}
            t={t}
          />
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
                disabled={!pnpmReady || busy}
                placeholder={t('marketplaceInstallPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => { setSpec(event.currentTarget.value) }}
              />
              <button
                className={css.primaryButton}
                type="submit"
                disabled={!pnpmReady || busy || spec.trim().length === 0}
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
            disabled={busy}
            onClick={() => { void api.restart() }}
          >
            {t('marketplaceRestart')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
