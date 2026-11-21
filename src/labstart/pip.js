export function isHudShortcut(event) {
    return event.isTrusted && !event.repeat && event.altKey && event.shiftKey &&
        !event.ctrlKey && !event.metaKey && event.code === 'KeyH'
}

let pending
function announce(open) {
    chrome.runtime.sendMessage({ type: 'labstart:hud-presence', open }).catch(() => {})
}

export function dismissHud() {
    const popup = window.documentPictureInPicture?.window
    if (!popup) return false
    popup.close()
    return true
}

export function installHudTrigger() {
    if (globalThis.labstartToggleHud) return
    const listener = (message, sender, respond) => {
        if (sender.id === chrome.runtime.id && message?.type === 'labstart:hud-dismiss') respond(dismissHud())
    }
    chrome.runtime.onMessage.addListener(listener)
    globalThis.labstartToggleHud = toggleHud
    globalThis.labstartStopHudTrigger = () => {
        chrome.runtime.onMessage.removeListener(listener)
        delete globalThis.labstartToggleHud
        delete globalThis.labstartStopHudTrigger
    }
}

export async function toggleHud() {
    if (pending) return pending
    const api = window.documentPictureInPicture
    if (dismissHud()) return false
    if (!api) throw new Error('Document Picture-in-Picture requires a secure Chromium page.')
    if (!navigator.userActivation.isActive) throw new Error('Click open floating HUD to allow Picture-in-Picture.')
    pending = (async () => {
        if (await chrome.runtime.sendMessage({ type: 'labstart:hud-dismiss-other' }).catch(() => false)) return false
        const window = await api.requestWindow({ width: 380, height: 248 })
        window.document.title = 'labstart'
        const frame = window.document.createElement('iframe')
        frame.src = chrome.runtime.getURL('hud-panel.html')
        frame.title = 'labstart status'
        frame.referrerPolicy = 'no-referrer'
        frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;background:#141414'
        window.document.body.append(frame)
        announce(true)
        window.addEventListener('pagehide', () => announce(false), { once: true })
        return true
    })()
    try {
        return await pending
    } finally {
        pending = null
    }
}
