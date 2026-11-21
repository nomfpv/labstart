import { CONFIG_KEY, WEB_ORIGINS, normalizeConfig } from './data/config.js'

const overlay = {
    id: 'labstart-overlays',
    matches: WEB_ORIGINS,
    js: ['content.js'],
    runAt: 'document_idle',
}
const themeKey = 'labstartTheme'
let overlayQueue = Promise.resolve()

function syncOverlays(inject = false) {
    overlayQueue = overlayQueue.catch(() => {}).then(async () => {
        const allowed = await chrome.permissions.contains({ origins: WEB_ORIGINS })
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [overlay.id] })
        if (allowed && !existing.length) {
            await chrome.scripting.registerContentScripts([overlay])
            if (inject) {
                const tabs = await chrome.tabs.query({ url: WEB_ORIGINS })
                await Promise.allSettled(tabs.map(({ id }) =>
                    chrome.scripting.executeScript({ target: { tabId: id }, files: overlay.js })))
            }
        } else if (!allowed && existing.length) {
            await chrome.scripting.unregisterContentScripts({ ids: [overlay.id] })
            const tabs = await chrome.tabs.query({})
            await Promise.allSettled(tabs.map(({ id }) => chrome.tabs.sendMessage(id, { type: 'labstart:detach' })))
        }
    })
    return overlayQueue
}

chrome.runtime.onStartup.addListener(() => syncOverlays().catch(() => {}))
chrome.runtime.onInstalled.addListener(() => syncOverlays().catch(() => {}))
chrome.permissions.onAdded.addListener(() => syncOverlays(true).catch(() => {}))
chrome.permissions.onRemoved.addListener(() => syncOverlays().catch(() => {}))

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return
    if (message?.type === 'labstart:theme') {
        chrome.storage.local.get(themeKey).then((data) => respond(data[themeKey])).catch(() => respond(null))
        return true
    }
    if (message?.type === 'labstart:window-fullscreen' && sender.tab?.windowId != null) {
        chrome.windows.get(sender.tab.windowId).then((window) => respond(window.state === 'fullscreen'))
            .catch(() => respond(false))
        return true
    }
    if (message?.type === 'labstart:disable-site' && /^https?:/.test(sender.url || '')) {
        const hostname = new URL(sender.url).hostname
        chrome.storage.local.get(CONFIG_KEY).then((data) => {
            const config = normalizeConfig(data[CONFIG_KEY])
            config.disabledSites = [...new Set([...config.disabledSites, hostname])]
            return chrome.storage.local.set({ [CONFIG_KEY]: config })
        }).catch(() => {})
    }
})

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[themeKey]) return
    chrome.tabs.query({ url: WEB_ORIGINS }).then((tabs) => Promise.allSettled(
        tabs.map(({ id }) => chrome.tabs.sendMessage(id, { type: 'labstart:theme', palette: changes[themeKey].newValue })),
    )).catch(() => {})
})
