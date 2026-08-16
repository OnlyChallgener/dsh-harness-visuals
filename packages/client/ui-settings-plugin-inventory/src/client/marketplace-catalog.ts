/** Public community catalog helpers for the desktop marketplace.
 *
 * The catalog is presentation data only. Every install spec is validated again
 * by the privileged desktop backend before it can reach `dsh plugin`.
 */

export interface MarketplaceCatalogDescription {
  en?: string
  zh?: string
}

export interface MarketplaceCatalogCategory {
  en?: string
  zh?: string
}

export interface MarketplaceCatalogPlugin {
  id: string
  name: string
  owner: string
  repository: string
  category: string
  description: MarketplaceCatalogDescription
  npm?: string
  stars?: number
  added?: string
  installSpec: string
}

export interface MarketplaceCatalog {
  updated?: string
  categories: Record<string, MarketplaceCatalogCategory>
  plugins: MarketplaceCatalogPlugin[]
}

export type MarketplaceCatalogSort = 'stars-desc' | 'added-desc'

const CATALOG_URL = 'https://raw.githubusercontent.com/dsh-market/dsh-market/main/data/registry-snapshot.json'
const CATALOG_TTL_MS = 60 * 60 * 1000
const CATALOG_TIMEOUT_MS = 6_000
const CATALOG_MAX_TEXT_LENGTH = 2_500_000
const CATALOG_MAX_PLUGINS = 1_200
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu
const REGISTRY_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[a-z0-9][a-z0-9._-]*)?$/iu
const GITHUB_SPEC_PATTERN = /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:#[a-z0-9][a-z0-9._\/-]*)?$/iu
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/iu
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

let catalogCache: { at: number; value: MarketplaceCatalog } | undefined

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0 || text.length > maxLength) return undefined
  return text
}

function safeRepository(value: unknown): string | undefined {
  const raw = boundedText(value, 300)
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return undefined
    if (!/^[a-z0-9_.-]+$/iu.test(segments[0] ?? '') || !/^[a-z0-9_.-]+$/iu.test(segments[1] ?? '')) return undefined
    return `https://github.com/${segments[0]}/${segments[1]}`
  } catch {
    return undefined
  }
}

function repositoryIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return undefined
    return `${segments[0]}/${segments[1]}`.toLowerCase()
  } catch {
    return undefined
  }
}

function githubSpecIdentity(spec: string): string | undefined {
  const match = /^github:([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:#.*)?$/iu.exec(spec)
  return match?.[1]?.toLowerCase()
}

function registryPackageName(spec: string): string | undefined {
  if (!REGISTRY_SPEC_PATTERN.test(spec)) return undefined
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const version = spec.indexOf('@', slash + 1)
    return version < 0 ? spec : spec.slice(0, version)
  }
  const version = spec.indexOf('@')
  return version < 0 ? spec : spec.slice(0, version)
}

/** Extract one safe package spec from the registry's human-readable command. */
export function catalogInstallSpec(value: unknown): string | undefined {
  const command = boundedText(value, 700)
  if (command === undefined) return undefined
  const match = /^dsh plugin --profile web add ([^\s]+)$/u.exec(command)
  if (match === null) return undefined
  const spec = match[1]
  if (spec === undefined) return undefined
  return REGISTRY_SPEC_PATTERN.test(spec) || GITHUB_SPEC_PATTERN.test(spec) ? spec : undefined
}

function normalizeDescription(value: unknown): MarketplaceCatalogDescription {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const en = boundedText(record.en, 900)
  const zh = boundedText(record.zh, 900)
  return {
    ...(en === undefined ? {} : { en }),
    ...(zh === undefined ? {} : { zh }),
  }
}

function normalizePlugin(value: unknown): MarketplaceCatalogPlugin | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const name = boundedText(record.name, 140)
  const owner = boundedText(record.owner, 100)
  const repository = safeRepository(record.url)
  const category = boundedText(record.category, 40)
  const installSpec = catalogInstallSpec(record.install)
  if (name === undefined || owner === undefined || repository === undefined || category === undefined || installSpec === undefined) return undefined
  if (!CATEGORY_PATTERN.test(category) || !/^[a-z0-9][a-z0-9_.-]*$/iu.test(owner)) return undefined

  const npm = boundedText(record.npm, 220)
  const safeNpm = npm !== undefined && PACKAGE_NAME_PATTERN.test(npm) ? npm : undefined
  const repoIdentity = repositoryIdentity(repository)
  if (repoIdentity === undefined || repoIdentity.split('/')[0] !== owner.toLowerCase()) return undefined

  // A remote catalog may describe a trusted-looking card but point its install
  // command somewhere else. Require the displayed source and install target to
  // agree before a one-click action is even rendered.
  if (installSpec.startsWith('github:')) {
    if (githubSpecIdentity(installSpec) !== repoIdentity) return undefined
  } else {
    const packageName = registryPackageName(installSpec)
    const expectedPackage = safeNpm ?? (PACKAGE_NAME_PATTERN.test(name) ? name : undefined)
    if (packageName === undefined || expectedPackage === undefined || packageName.toLowerCase() !== expectedPackage.toLowerCase()) return undefined
  }

  const stars = typeof record.stars === 'number' && Number.isFinite(record.stars) && record.stars >= 0
    ? Math.min(10_000_000, Math.floor(record.stars))
    : undefined
  const added = typeof record.added === 'string' && DATE_PATTERN.test(record.added) ? record.added : undefined
  return {
    id: `${owner}/${name}`,
    name,
    owner,
    repository,
    category,
    description: normalizeDescription(record.description),
    ...(safeNpm === undefined ? {} : { npm: safeNpm }),
    ...(stars === undefined ? {} : { stars }),
    ...(added === undefined ? {} : { added }),
    installSpec,
  }
}

/** Normalize untrusted registry JSON into the small, render-safe surface used by the UI. */
export function normalizeMarketplaceCatalog(value: unknown): MarketplaceCatalog {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Marketplace catalog payload is invalid.')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.plugins)) throw new Error('Marketplace catalog has no plugin list.')

  const categories: Record<string, MarketplaceCatalogCategory> = {}
  if (record.categories !== null && typeof record.categories === 'object' && !Array.isArray(record.categories)) {
    for (const [id, raw] of Object.entries(record.categories as Record<string, unknown>)) {
      if (!CATEGORY_PATTERN.test(id) || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const labels = raw as Record<string, unknown>
      const en = boundedText(labels.en, 100)
      const zh = boundedText(labels.zh, 100)
      categories[id] = {
        ...(en === undefined ? {} : { en }),
        ...(zh === undefined ? {} : { zh }),
      }
    }
  }

  const seen = new Set<string>()
  const plugins: MarketplaceCatalogPlugin[] = []
  for (const raw of record.plugins.slice(0, CATALOG_MAX_PLUGINS)) {
    const plugin = normalizePlugin(raw)
    if (plugin === undefined) continue
    const identity = plugin.id.toLowerCase()
    if (seen.has(identity)) continue
    seen.add(identity)
    plugins.push(plugin)
    if (categories[plugin.category] === undefined) categories[plugin.category] = { en: plugin.category, zh: plugin.category }
  }
  if (plugins.length === 0) throw new Error('Marketplace catalog contains no supported plugin entries.')

  const updated = typeof record.updated === 'string' && DATE_PATTERN.test(record.updated) ? record.updated : undefined
  return {
    ...(updated === undefined ? {} : { updated }),
    categories,
    plugins,
  }
}

/** Load the public catalog only when the Recommended view mounts. */
export async function loadMarketplaceCatalog(fetchImpl: typeof fetch = globalThis.fetch): Promise<MarketplaceCatalog> {
  if (catalogCache !== undefined && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
  if (typeof fetchImpl !== 'function') throw new Error('Marketplace catalog fetch is unavailable.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const response = await fetchImpl(CATALOG_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new Error(`Marketplace catalog request failed (${response.status}).`)
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > CATALOG_MAX_TEXT_LENGTH) throw new Error('Marketplace catalog is too large.')
    const text = await response.text()
    if (text.length === 0 || text.length > CATALOG_MAX_TEXT_LENGTH) throw new Error('Marketplace catalog is empty or too large.')
    const value = normalizeMarketplaceCatalog(JSON.parse(text))
    catalogCache = { at: Date.now(), value }
    return value
  } catch (error) {
    if (catalogCache !== undefined) return catalogCache.value
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function filterMarketplaceCatalog(
  plugins: readonly MarketplaceCatalogPlugin[],
  options: { query: string; category: string; sort: MarketplaceCatalogSort },
): MarketplaceCatalogPlugin[] {
  const query = options.query.trim().toLowerCase()
  const filtered = plugins.filter(plugin => {
    if (options.category !== 'all' && plugin.category !== options.category) return false
    if (query.length === 0) return true
    const haystack = [
      plugin.name,
      plugin.owner,
      plugin.npm ?? '',
      plugin.description.en ?? '',
      plugin.description.zh ?? '',
    ].join('\n').toLowerCase()
    return haystack.includes(query)
  })
  if (options.sort === 'added-desc') {
    return [...filtered].sort((left, right) => String(right.added ?? '').localeCompare(String(left.added ?? '')))
  }
  return [...filtered].sort((left, right) => (right.stars ?? -1) - (left.stars ?? -1))
}

/** Match catalog rows to installed dependencies without substring guesses. */
export function catalogPluginInstalled(
  plugin: MarketplaceCatalogPlugin,
  installed: readonly { name: string; repository?: string }[],
): boolean {
  const npm = plugin.npm?.toLowerCase()
  const name = plugin.name.toLowerCase()
  const repository = repositoryIdentity(plugin.repository)
  return installed.some(item => {
    const installedName = item.name.toLowerCase()
    if (npm !== undefined && installedName === npm) return true
    const installedRepository = repositoryIdentity(item.repository)
    if (repository !== undefined && installedRepository !== undefined) return repository === installedRepository
    return npm === undefined && installedRepository === undefined && installedName === name
  })
}
