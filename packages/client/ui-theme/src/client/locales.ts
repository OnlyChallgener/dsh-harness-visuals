/** `settings.theme` namespace dictionaries (the Appearance row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'appearance.wallpaper': '壁纸',
  'appearance.wallpaper.none': '未设置本地壁纸',
  'appearance.wallpaper.choose': '选择壁纸',
  'appearance.wallpaper.replace': '更换壁纸',
  'appearance.wallpaper.clear': '恢复默认',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'appearance.wallpaper': 'Wallpaper',
  'appearance.wallpaper.none': 'No local wallpaper',
  'appearance.wallpaper.choose': 'Choose wallpaper',
  'appearance.wallpaper.replace': 'Replace wallpaper',
  'appearance.wallpaper.clear': 'Reset',
} satisfies Record<ThemeKey, string>
