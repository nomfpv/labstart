import '@fontsource-variable/geist-mono'
import '../app.css'
import './hud.css'
import { applySavedTheme } from './theme.js'
import { CONFIG_KEY, STATE_KEY, normalizeConfig } from './data/config.js'
import { boxMetric, displayedBoxes, formatMetric, sparkPath } from './metrics.js'
import { isHudShortcut } from './pip.js'

const rows = document.querySelector('#rows')
let config = normalizeConfig()
let state

function render() {
    if (document.hidden) return
    const metrics = new Map()
    const seen = new Set()
    for (const box of displayedBoxes(config, state)) {
        for (const row of box.rows) {
            const metric = boxMetric(state, row)
            if (metric && !seen.has(metric) && !metrics.has(row.label) &&
                (typeof metric.value === 'number' || metric.history?.length > 1)) {
                metrics.set(row.label, metric)
                seen.add(metric)
            }
        }
    }
    for (const source of Object.values(state?.sources || {})) {
        for (const metric of Object.values(source.metrics || {})) {
            if (metric.history?.length > 1 && !seen.has(metric) && !metrics.has(metric.label)) {
                metrics.set(metric.label, metric)
                seen.add(metric)
            }
        }
    }
    rows.replaceChildren()
    if (!metrics.size) {
        rows.textContent = 'waiting for source data'
        return
    }
    for (const [label, metric] of [...metrics].slice(0, 6)) {
        const line = document.createElement('div')
        line.className = 'hud-row'
        const name = document.createElement('span')
        name.textContent = label
        const plot = document.createElement('span')
        plot.className = 'spark ' + (metric.severity || '')
        plot.setAttribute('aria-hidden', 'true')
        const path = sparkPath(metric.history)
        if (path) {
            const ns = 'http://www.w3.org/2000/svg'
            const svg = document.createElementNS(ns, 'svg')
            svg.setAttribute('viewBox', '0 0 100 20')
            svg.setAttribute('preserveAspectRatio', 'none')
            for (const [name, d] of [['area', path.area], ['line', path.line]]) {
                const shape = document.createElementNS(ns, 'path')
                shape.setAttribute('class', name)
                shape.setAttribute('d', d)
                svg.append(shape)
            }
            plot.append(svg)
        }
        const value = document.createElement('strong')
        value.textContent = formatMetric(metric)
        value.className = metric.severity || ''
        line.append(name, plot, value)
        rows.append(line)
    }
}

function refreshTheme() {
    if (!document.hidden) applySavedTheme()
}
refreshTheme()
const changed = (changes, area) => {
    if (area === 'local' && changes[CONFIG_KEY]) config = normalizeConfig(changes[CONFIG_KEY].newValue)
    else if (area === 'session' && changes[STATE_KEY]) state = changes[STATE_KEY].newValue
    else return
    render()
}
chrome.storage.onChanged.addListener(changed)
chrome.storage.local.get(CONFIG_KEY).then((data) => {
    config = normalizeConfig(data[CONFIG_KEY])
    render()
})
chrome.storage.session.get(STATE_KEY).then((data) => {
    state = data[STATE_KEY]
    render()
})
window.addEventListener('storage', (event) => {
    if (event.key === 'settings') refreshTheme()
})
document.addEventListener('visibilitychange', () => {
    refreshTheme()
    render()
})
document.querySelector('#close').addEventListener('click', () => window.parent.close())
window.addEventListener('keydown', (event) => {
    if (isHudShortcut(event)) {
        event.preventDefault()
        window.parent.close()
    }
})
