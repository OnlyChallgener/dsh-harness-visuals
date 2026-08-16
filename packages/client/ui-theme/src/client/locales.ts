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
  'appearance.wallpaper.priority': '本地壁纸启用时优先显示；恢复默认后，第三方壁纸插件可重新接管背景。',
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
  'appearance.wallpaper.priority': 'Local wallpaper takes visual priority. Reset it to let a third-party wallpaper plugin take over again.',
} satisfies Record<ThemeKey, string>
