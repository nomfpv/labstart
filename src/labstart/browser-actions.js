import { CONFIG_KEY, WEB_ORIGINS, normalizeConfig } from './data/config.js'

const overlay = {
    id: 'labstart-overlays',
    matches: WEB_ORIGINS,
    js: ['content.js'],
    runAt: 'document_idle',
}
const themeKey = 'labstartTheme'
const hudKey = 'labstartHudOwner'
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

async function dismissOwner(exceptTab) {
    const { [hudKey]: owner } = await chrome.storage.session.get(hudKey)
    if (owner?.tabId == null || owner.tabId === exceptTab) return false
    const closed = await chrome.tabs.sendMessage(owner.tabId, { type: 'labstart:hud-dismiss' }).catch(() => false)
    if (!closed) await chrome.storage.session.remove(hudKey)
    return closed
}

async function tryHud(tabId) {
    const target = { tabId }
    const run = async () => {
        if (!globalThis.labstartToggleHud) return 'missing'
        try {
            await globalThis.labstartToggleHud()
            return 'handled'
        } catch {
            return 'blocked'
        }
    }
    const invoke = () => chrome.scripting.executeScript({ target, func: run }).then((results) => results[0]?.result)
    let result = await invoke()
    if (result === 'missing') {
        await chrome.scripting.executeScript({ target, files: ['hud-trigger.js'] })
        result = await invoke()
    }
    return result === 'handled'
}

async function handleToolbar(tab) {
    if (await dismissOwner()) return
    if (tab?.id != null) {
        if (await tryHud(tab.id).catch(() => false)) return
    }
    const url = chrome.runtime.getURL('hud.html')
    const [launcher] = await chrome.tabs.query({ url })
    if (launcher) await chrome.tabs.update(launcher.id, { active: true })
    else await chrome.tabs.create({ url })
}

chrome.action.onClicked.addListener((tab) => handleToolbar(tab).catch(() => {}))
chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-hud') handleToolbar(tab).catch(() => {})
})
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
    if (message?.type === 'labstart:hud-presence' && sender.tab?.id != null) {
        const owner = { tabId: sender.tab.id, documentId: sender.documentId }
        if (message.open) chrome.storage.session.set({ [hudKey]: owner }).catch(() => {})
        else chrome.storage.session.get(hudKey).then((data) => {
            if (data[hudKey]?.documentId === owner.documentId) return chrome.storage.session.remove(hudKey)
        }).catch(() => {})
    }
    if (message?.type === 'labstart:hud-dismiss-other' && sender.tab?.id != null) {
        dismissOwner(sender.tab.id).then(respond).catch(() => respond(false))
        return true
    }
    if (message?.type === 'labstart:open-launcher' && sender.tab?.id != null) {
        chrome.tabs.create({ url: chrome.runtime.getURL('hud.html') }).catch(() => {})
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
