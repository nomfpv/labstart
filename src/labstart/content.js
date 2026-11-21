import style from './content.css?inline'

const videoHosts = /(^|\.)(youtube\.com|youtu\.be|netflix\.com|twitch\.tv|vimeo\.com|disneyplus\.com|primevideo\.com|hulu\.com|max\.com)$/i

function startOverlay() {
    if (globalThis.labstartCloseOverlay || !document.documentElement || !/^https?:$/.test(location.protocol)) return
    const host = document.createElement('labstart-status')
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
    const rdns = {}

    corner.toggleAttribute('data-video', videoHosts.test(location.hostname))
    const time = (value) => Number.isFinite(value) ? Math.round(value) + 'ms' : null

    function displayDetails(expanded) {
        details.hidden = !expanded
        chip.setAttribute('aria-expanded', String(expanded))
        corner.toggleAttribute('data-expanded', expanded)
        if (!expanded || !site) return
        const values = {
            'remote IP': site.ip,
            'reverse DNS': config?.rdnsEnabled || config?.demoMode ? (rdns[site.ip] ?? '…') : null,
            'ASN': site.asn ? ['AS' + site.asn, site.org].filter(Boolean).join(' ') : null,
            'protocol': site.protocol,
            'TTFB': time(site.ttfb),
            'connect': time(site.connect),
            'CDN (estimate)': site.cdn,
        }
        if ((config?.rdnsEnabled || config?.demoMode) && site.ip && !(site.ip in rdns)) {
            rdns[site.ip] = '…'
            const ip = site.ip
            chrome.runtime.sendMessage({ type: 'labstart:rdns', ip }).then((name) => {
                rdns[ip] = name || '—'
                if (!details.hidden && site?.ip === ip) displayDetails(true)
            }).catch(() => { rdns[ip] = '—' })
        }
        list.replaceChildren()
        for (const [label, value] of Object.entries(values)) {
            if (label === 'reverse DNS' && value === null) continue
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
        const parts = [
            site.family,
            site.asn ? ['AS' + site.asn, site.org].filter(Boolean).join(' ') : null,
            site.protocol,
            time(site.ttfb),
        ].filter(Boolean)
        chip.replaceChildren(...parts.flatMap((part, index) => {
            const text = document.createElement('span')
            text.textContent = part
            if (!index) return [text]
            const bar = document.createElement('span')
            bar.className = 'sep'
            bar.textContent = ' │ '
            return [bar, text]
        }))
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
        chrome.runtime.sendMessage({ type: 'labstart:window-fullscreen' }).then((fullscreen) => {
            browserFullscreen = fullscreen
            render()
        }).catch(() => {})
    }

    let request = 0
    async function getSite() {
        const latest = ++request
        const navigation = performance.getEntriesByType('navigation')[0]
        const result = await chrome.runtime.sendMessage({
            type: 'labstart:site',
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
        if (message.type === 'labstart:detach') globalThis.labstartCloseOverlay()
        if (message.type === 'labstart:theme') applyPalette(message.palette)
        if (message.type === 'labstart:site-refresh') getSite()
        if (message.type === 'labstart:site-update') {
            site = message.site
            render()
        }
        if (message.type === 'labstart:update') {
            const refresh = config?.demoMode !== message.config.demoMode || config?.asnEnabled !== message.config.asnEnabled || config?.rdnsEnabled !== message.config.rdnsEnabled
            config = message.config
            renderState(message.state)
            if (refresh) getSite()
            else render()
        }
    }
    chrome.runtime.onMessage.addListener(messages)
    globalThis.labstartCloseOverlay = () => {
        controller.abort()
        clearTimeout(scrollTimer)
        clearTimeout(resizeTimer)
        chrome.runtime.onMessage.removeListener(messages)
        host.remove()
        delete globalThis.labstartCloseOverlay
    }

    chip.addEventListener('click', () => displayDetails(details.hidden), active)
    off.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'labstart:disable-site' }).catch(() => {})
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
    // The chip steps aside when the pointer comes near it. Reaching it on purpose works by moving
    // along the bottom edge of the window, which brings it back and keeps it in place.
    const NEAR = 48
    const EDGE = 12
    document.addEventListener('pointermove', (event) => {
        if (corner.hidden || !details.hidden || shadow.activeElement || event.pointerType !== 'mouse') return
        baseBounds ||= chip.getBoundingClientRect()
        const { clientX: x, clientY: y } = event
        const onChip = x >= baseBounds.left && x <= baseBounds.right && y >= baseBounds.top && y <= baseBounds.bottom
        const near = x > baseBounds.left - NEAR && y > baseBounds.top - NEAR
        const edge = y >= innerHeight - EDGE
        if (edge || (onChip && !moved)) {
            if (moved) corner.removeAttribute('data-away')
            moved = false
        } else if (near && !onChip) {
            if (!moved) corner.setAttribute('data-away', '')
            moved = true
        } else if (!near && moved) {
            corner.removeAttribute('data-away')
            moved = false
        }
    }, { passive: true, ...active })
    document.addEventListener('pointerleave', () => {
        if (moved) corner.removeAttribute('data-away')
        moved = false
    }, active)
    document.documentElement.append(host)
    chrome.runtime.sendMessage({ type: 'labstart:theme' }).then(applyPalette).catch(() => {})
    checkWindowFullscreen()
    getSite()
}

startOverlay()
