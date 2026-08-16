/**
 * Appearance preference row registered into the General section item slot
 * (figma 501:30012 'Frame 2117131228'): title + three preference cubes.
 * Registered by this package — the theme feature owns its own settings
 * surface. Selection follows the persisted preference, never the resolved
 * active theme. Device-local wallpaper sits below the palette choice and never
 * enters Host/session persistence.
 */
import clsx from 'clsx'
import { useRef, useSyncExternalStore } from 'react'
import {
  IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemePreference } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createAppearanceRowStore } from './settings-store.ts'
import {
  clearWallpaper, getWallpaperSnapshot, setWallpaper, subscribeWallpaper,
} from './wallpaper.ts'
import css from './AppearanceRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface AppearanceRowInjected {
  /** Switch the theme preference. */
  setTheme: (id: ThemePreference) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type AppearanceRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createAppearanceRowStore>>
  & PropsLocale<'settings.theme'> & AppearanceRowInjected

/** Cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const CUBES: readonly { id: ThemePreference; labelKey: ThemeKey; Icon: typeof IconLightOutline16 }[] = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutline16 },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutline16 },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutline16 },
]

/**
 * Render the Appearance row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function AppearanceRow({ t, setTheme, useStore }: AppearanceRowComponentProps) {
  const preference = useStore(s => s.preference)
  const wallpaper = useSyncExternalStore(subscribeWallpaper, getWallpaperSnapshot, getWallpaperSnapshot)
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.title')}</div>
      <div className={css.cubeRow}>
        {CUBES.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.themeCube, preference === id && css.selected)}
            aria-pressed={preference === id}
            onClick={() => { setTheme(id) }}
          >
            <Icon />
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className={css.wallpaperRow}>
        <div className={css.wallpaperText}>
          <span className={css.wallpaperTitle}>{t('appearance.wallpaper')}</span>
          <span className={css.wallpaperName}>
            {wallpaper.name ?? t('appearance.wallpaper.none')}
          </span>
        </div>
        <div className={css.wallpaperActions}>
          <button
            type="button"
            className={css.wallpaperButton}
            disabled={wallpaper.busy}
            onClick={() => { fileInput.current?.click() }}
          >
            {wallpaper.name === undefined ? t('appearance.wallpaper.choose') : t('appearance.wallpaper.replace')}
          </button>
          {wallpaper.name !== undefined && (
            <button
              type="button"
              className={css.wallpaperButton}
              disabled={wallpaper.busy}
              onClick={() => { void clearWallpaper() }}
            >
              {t('appearance.wallpaper.clear')}
            </button>
          )}
          <input
            ref={fileInput}
            className={css.fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void setWallpaper(file)
            }}
          />
        </div>
      </div>
      {wallpaper.error !== undefined && <div className={css.wallpaperError} role="alert">{wallpaper.error}</div>}
    </div>
  )
}
