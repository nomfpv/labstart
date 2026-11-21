import { defaultCustomColors } from '../config/themes.js'

const todoistSecretKey = 'termbarTodoistToken'
const extensionStorage = globalThis.chrome?.storage?.local
let todoistReady = false
let lastTodoistToken
let todoistWrite = Promise.resolve()

function detectFormatPreferences() {
    try {
        const use24h = !new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
        }).resolvedOptions().hour12
        const dayBeforeMonth =
            new Intl.DateTimeFormat().formatToParts(new Date())[0].type ===
            'day'
        const useFahrenheit = navigator.language === 'en-US'
        const useImperial = useFahrenheit
        return {
            timeFormat: use24h ? '24hr' : '12hr',
            dateFormat: dayBeforeMonth ? 'dmy' : 'mdy',
            tempUnit: useFahrenheit ? 'fahrenheit' : 'celsius',
            speedUnit: useImperial ? 'mph' : 'kmh',
        }
    } catch {
        return {}
    }
}

let defaultSettings = {
    font: 'Geist Mono Variable',
    fontWeight: 400,
    currentTheme: 'default',
    tabTitle: '~',
    taskBackend: 'local',
    todoistApiToken: '',
    googleTasksSignedIn: false,
    locationMode: 'manual',
    latitude: null,
    longitude: null,
    showSeconds: true,
    timeFormat: '12hr',
    dateFormat: 'mdy',
    tempUnit: 'fahrenheit',
    speedUnit: 'mph',
    aqiScale: 'us',
    forecastMode: 'hourly',
    linksPerColumn: 4,
    linkTarget: '_self',
    linkHotkeys: false,
    linkHotkeyPosition: 'right',
    linkIconMode: 'icons',
    links: [
        { title: 'dashboard', url: 'https://status.example.com', icon: 'grafana', hotkey: 's' },
        { title: 'docs', url: 'https://docs.example.com', icon: 'readthedocs', hotkey: 'd' },
        { title: 'notes', url: 'https://notes.example.com', icon: 'obsidian', hotkey: 'n' },
        { title: 'calendar', url: 'https://example.com/calendar', icon: 'googlecalendar', hotkey: 'c' },
    ],
    customThemeColors: { ...defaultCustomColors },
    pingUrl: '',
    customCSS: '',
    showClock: true,
    showStats: true,
    showWeather: true,
    showTasks: true,
    showLinks: true,
}

function loadSettings() {
    try {
        const stored = localStorage.getItem('settings')
        if (stored) {
            const parsed = JSON.parse(stored)
            const merged = { ...defaultSettings, ...parsed }
            if (!merged.customThemeColors) {
                merged.customThemeColors = { ...defaultCustomColors }
            }
            // migrate old showLinkIcons boolean to linkIconMode
            if ('showLinkIcons' in parsed) {
                merged.linkIconMode =
                    parsed.showLinkIcons === false ? 'arrow' : 'icons'
                delete merged.showLinkIcons
            }
            // migrate links to add hotkey field
            if (merged.links) {
                merged.links = merged.links.map((link) => ({
                    ...link,
                    hotkey: link.hotkey ?? '',
                }))
            }
            return merged
        }
    } catch (error) {
        console.error('failed to load settings from localStorage:', error)
    }

    const detected = detectFormatPreferences()
    return { ...defaultSettings, ...detected }
}

export function saveSettings(settings) {
    try {
        const { todoistApiToken, ...preferences } = settings
        localStorage.setItem('settings', JSON.stringify(preferences))
        if (todoistReady && lastTodoistToken !== todoistApiToken) {
            lastTodoistToken = todoistApiToken
            const write = () => todoistApiToken
                ? extensionStorage.set({ [todoistSecretKey]: todoistApiToken })
                : extensionStorage.remove(todoistSecretKey)
            todoistWrite = todoistWrite.catch(() => {}).then(write)
            todoistWrite.catch(() => {})
        }
    } catch (error) {
        console.error('failed to save settings to localStorage:', error)
    }
}

export function resetSettings() {
    try {
        localStorage.removeItem('settings')
        // Reset the settings object to default
        const newSettings = loadSettings()
        Object.assign(settings, newSettings)
        return true
    } catch (error) {
        console.error('failed to reset settings:', error)
        return false
    }
}

export const settings = $state(loadSettings())

if (extensionStorage) {
    const legacyToken = settings.todoistApiToken
    extensionStorage.get(todoistSecretKey).then((data) => {
        lastTodoistToken = data[todoistSecretKey] || ''
        if (settings.todoistApiToken === legacyToken) {
            settings.todoistApiToken = lastTodoistToken || legacyToken
        }
        todoistReady = true
        saveSettings(settings)
    }).catch(() => {})
}
