import style from './content.css?inline'
import { installHudTrigger, isHudShortcut, toggleHud } from './pip.js'

const videoHosts = /(^|\.)(youtube\.com|youtu\.be|netflix\.com|twitch\.tv|vimeo\.com|disneyplus\.com|primevideo\.com|hulu\.com|max\.com)$/i

function startOverlay() {
    if (globalThis.termbarCloseOverlay || !document.documentElement || !/^https?:$/.test(location.protocol)) return
    const host = document.createElement('termbar-status')
    const shadow = host.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(`@font-face { font-family: "Geist Mono Variable"; src: url("${chrome.runtime.getURL('icons/geist-mono.woff2')}") format("woff2"); font-weight: 100 900; font-display: swap; }\n${style}`)
    shadow.adoptedStyleSheets = [sheet]
    const shell = document.createElement('div')
    shell.className = 'overlay'
    shell.innerHTML = `
        <div id="alert" hidden aria-hidden="true"></div>
        <div id="corner" hidden>
            <section id="details" aria-label="site connection" hidden>
                <h2>connection</h2>
                <dl></dl>
                <button id="off" type="button">hide chip on this site</button>
            </section>
            <button id="chip" type="button" aria-expanded="false" aria-controls="details"></button>
        </div>`
    shadow.append(shell)
    const alert = shell.querySelector('#alert')
    const corner = shell.querySelector('#corner')
    const details = shell.querySelector('#details')
    const chip = shell.querySelector('#chip')
    const list = details.querySelector('dl')
    const off = details.querySelector('#off')
    const controller = new AbortController()
    const active = { signal: controller.signal }
    let config
    let site
    let scrollTimer
    let resizeTimer
    let browserFullscreen = false
    let moved = false
    let baseBounds

    corner.toggleAttribute('data-video', videoHosts.test(location.hostname))
    const time = (value) => Number.isFinite(value) ? Math.round(value) + 'ms' : null

    function displayDetails(expanded) {
        details.hidden = !expanded
        chip.setAttribute('aria-expanded', String(expanded))
        corner.toggleAttribute('data-expanded', expanded)
        if (!expanded || !site) return
        const values = {
            'remote IP': site.ip,
            'ASN': site.asn ? ['AS' + site.asn, site.org].filter(Boolean).join(' ') : null,
            'protocol': site.protocol,
            'TTFB': time(site.ttfb),
            'connect': time(site.connect),
            'CDN (estimate)': site.cdn,
        }
        list.replaceChildren()
        for (const [label, value] of Object.entries(values)) {
            const name = document.createElement('dt')
            const field = document.createElement('dd')
            name.textContent = label
            field.textContent = value || '—'
            list.append(name, field)
        }
    }

    function render() {
        const full = document.fullscreenElement || document.webkitFullscreenElement || browserFullscreen
        const blocked = config?.disabledSites?.includes(location.hostname.toLowerCase())
        const visible = config?.chipEnabled && !blocked && !full && (site?.ip || site?.protocol || time(site?.ttfb))
        corner.hidden = !visible
        if (!visible) {
            displayDetails(false)
            return
        }
        chip.textContent = [
            site.family,
            site.asn ? ['AS' + site.asn, site.org].filter(Boolean).join(' ') : null,
            site.protocol,
            time(site.ttfb),
        ].filter(Boolean).join(' │ ')
        baseBounds = null
        if (!details.hidden) displayDetails(true)
    }

    function renderState(state) {
        const severity = state?.severity
        alert.hidden = severity !== 'warn' && severity !== 'crit'
        if (!alert.hidden) alert.dataset.severity = severity
    }

    function applyPalette(palette) {
        for (const key of ['--bg-1', '--bg-2', '--bg-3', '--txt-1', '--txt-2', '--txt-3',
            '--txt-4', '--txt-err', '--font-family', '--font-weight']) {
            if (palette?.[key]) shell.style.setProperty(key, palette[key])
        }
    }

    function checkWindowFullscreen() {
        chrome.runtime.sendMessage({ type: 'termbar:window-fullscreen' }).then((fullscreen) => {
            browserFullscreen = fullscreen
            render()
        }).catch(() => {})
    }

    let request = 0
    async function getSite() {
        const latest = ++request
        const navigation = performance.getEntriesByType('navigation')[0]
        const result = await chrome.runtime.sendMessage({
            type: 'termbar:site',
            timing: {
                timeOrigin: performance.timeOrigin,
                protocol: navigation?.nextHopProtocol || null,
                ttfb: navigation?.responseStart > 0 ? navigation.responseStart : null,
                connect: navigation?.connectEnd > navigation?.connectStart
                    ? navigation.connectEnd - navigation.connectStart : null,
            },
        }).catch(() => {})
        if (!result || latest !== request) return
        config = result.config
        site = result.site
        renderState(result.state)
        render()
    }

    const messages = (message, sender) => {
        if (sender.id !== chrome.runtime.id) return
        if (message.type === 'termbar:detach') globalThis.termbarCloseOverlay()
        if (message.type === 'termbar:theme') applyPalette(message.palette)
        if (message.type === 'termbar:site-refresh') getSite()
        if (message.type === 'termbar:site-update') {
            site = message.site
            render()
        }
        if (message.type === 'termbar:update') {
            const refresh = config?.demoMode !== message.config.demoMode || config?.asnEnabled !== message.config.asnEnabled
            config = message.config
            renderState(message.state)
            if (refresh) getSite()
            else render()
        }
    }
    chrome.runtime.onMessage.addListener(messages)
    installHudTrigger()
    globalThis.termbarCloseOverlay = () => {
        controller.abort()
        clearTimeout(scrollTimer)
        clearTimeout(resizeTimer)
        chrome.runtime.onMessage.removeListener(messages)
        if (!window.documentPictureInPicture?.window) globalThis.termbarStopHudTrigger?.()
        host.remove()
        delete globalThis.termbarCloseOverlay
    }

    chip.addEventListener('click', () => displayDetails(details.hidden), active)
    off.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'termbar:disable-site' }).catch(() => {})
        displayDetails(false)
        corner.hidden = true
    }, active)
    document.addEventListener('fullscreenchange', render, active)
    window.addEventListener('resize', () => {
        baseBounds = null
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(checkWindowFullscreen, 100)
    }, active)
    window.addEventListener('pageshow', getSite, active)
    window.addEventListener('keydown', (event) => {
        if (isHudShortcut(event)) {
            event.preventDefault()
            toggleHud().catch(() => chrome.runtime.sendMessage({ type: 'termbar:open-launcher' }).catch(() => {}))
        }
        if (event.key === 'Escape' && !details.hidden) {
            displayDetails(false)
            chip.focus()
        }
    }, { capture: true, ...active })
    document.addEventListener('scroll', () => {
        if (corner.hidden || !details.hidden || shadow.activeElement) return
        clearTimeout(scrollTimer)
        corner.setAttribute('data-scroll', '')
        scrollTimer = setTimeout(() => corner.removeAttribute('data-scroll'), 220)
    }, { passive: true, capture: true, ...active })
    document.addEventListener('pointermove', (event) => {
        if (corner.hidden || !details.hidden || shadow.activeElement || event.pointerType !== 'mouse') return
        if (event.clientY < innerHeight - 52) {
            if (moved) corner.removeAttribute('data-away')
            moved = false
            return
        }
        baseBounds ||= chip.getBoundingClientRect()
        // Leave the bottom edge available for deliberately reaching the chip.
        if (!moved && event.clientX > baseBounds.left - 10 && event.clientX < baseBounds.right + 10 &&
            event.clientY < baseBounds.top && event.clientY > baseBounds.top - 14) {
            moved = true
            corner.setAttribute('data-away', '')
        }
        if (moved && (event.clientX < baseBounds.left - 10 || event.clientY > baseBounds.bottom)) {
            moved = false
            corner.removeAttribute('data-away')
        }
    }, { passive: true, ...active })
    document.documentElement.append(host)
    chrome.runtime.sendMessage({ type: 'termbar:theme' }).then(applyPalette).catch(() => {})
    checkWindowFullscreen()
    getSite()
}

startOverlay()
