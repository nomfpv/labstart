import '../lib/config/themes.css'
import { defaultCustomColors, defaultTheme, themes } from '../lib/config/themes.js'

export const THEME_KEY = 'termbarTheme'
export const colorNames = ['--bg-1', '--bg-2', '--bg-3', '--txt-1', '--txt-2', '--txt-3', '--txt-4', '--txt-err']
const customNames = ['bg1', 'bg2', 'bg3', 'txt1', 'txt2', 'txt3', 'txt4', 'txtErr']

export function applyTheme(settings = {}, root = document.documentElement) {
    const name = Object.hasOwn(themes, settings.currentTheme) ? settings.currentTheme : defaultTheme
    root.classList.remove(...Array.from(root.classList).filter((name) => name.startsWith('theme-')))
    root.classList.add('theme-' + name)
    const style = root.style
    const colors = settings.customThemeColors || defaultCustomColors
    colorNames.forEach((key, i) => {
        const value = colors[customNames[i]]
        if (name === 'custom' && typeof value === 'string' && CSS.supports('color', value)) {
            style.setProperty(key, value)
        } else {
            style.removeProperty(key)
        }
    })
    const font = typeof settings.font === 'string' ? settings.font.trim() : ''
    const family = '"' + (font || 'Geist Mono Variable').replace(/[;"<>]/g, '') + '", monospace'
    const weight = Math.min(900, Math.max(100, Number(settings.fontWeight) || 400))
    style.setProperty('--font-family', family)
    style.setProperty('--font-weight', weight)
    style.setProperty('--font-weight-light', Math.max(100, weight - 100))
}

export function applySavedTheme() {
    try {
        applyTheme(JSON.parse(localStorage.getItem('settings') || '{}'))
    } catch {
        applyTheme()
    }
}

let lastPublished
export function publishTheme() {
    if (!globalThis.chrome?.storage?.local) return
    const style = getComputedStyle(document.documentElement)
    const palette = Object.fromEntries([...colorNames, '--font-family', '--font-weight'].map(
        (key) => [key, style.getPropertyValue(key).trim()],
    ))
    const serialized = JSON.stringify(palette)
    if (lastPublished === serialized) return
    lastPublished = serialized
    chrome.storage.local.get(THEME_KEY).then((data) => {
        if (JSON.stringify(data[THEME_KEY]) !== serialized) return chrome.storage.local.set({ [THEME_KEY]: palette })
    }).catch(() => {})
}
