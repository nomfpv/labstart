export const CONFIG_KEY = 'labstartConfig'
export const SECRETS_KEY = 'labstartSecrets'
export const STATE_KEY = 'labstartState'
export const MIN_INTERVAL = 30
export const WEB_ORIGINS = ['http://*/*', 'https://*/*']
export const RIPE_ORIGIN = 'https://stat.ripe.net/*'
export const DOH_ORIGIN = 'https://cloudflare-dns.com/*'
export const CLAUDE_ORIGIN = 'https://claude.ai/*'

// Cloudflare's public resolver addresses select the address family without DNS.
export const EGRESS_URLS = {
    ipv4: 'https://1.1.1.1/cdn-cgi/trace',
    ipv6: 'https://[2606:4700:4700::1111]/cdn-cgi/trace',
}

export const SOURCE_TYPES = ['custom', 'kuma', 'adguard', 'egress', 'claude']
export const SOURCE_LABELS = {
    custom: 'custom JSON', kuma: 'Uptime Kuma', adguard: 'AdGuard Home',
    egress: 'own egress', claude: 'Claude usage (unofficial)',
}

const row = (label, metricId = label) => ({ label, sourceId: '', metricId })
export const DEFAULT_CONFIG = {
    demoMode: false,
    demoOutage: false,
    chipEnabled: true,
    disabledSites: [],
    asnEnabled: false,
    rdnsEnabled: false,
    notificationsEnabled: true,
    badge: { sourceId: '', metricId: '' },
    boxes: [
        { id: 'homelab', label: 'homelab', enabled: true, rows: [
            row('load'), row('temp'), row('containers'), row('tunnels'), row('monitors'),
        ] },
        { id: 'net', label: 'net', enabled: true, rows: [
            row('ipv4'), row('ipv6'), row('latency'), row('dns blocked', 'blocked'),
        ] },
        { id: 'claude', label: 'claude', enabled: true, rows: [row('usage')] },
    ],
    sources: [],
}

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const list = value => Array.isArray(value) ? value : []
const string = (value, limit = 120) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

function uniqueById(items) {
    return [...new Map(items.map(item => [item.id, item])).values()]
}

function normalizeId(value, fallback) {
    const id = string(value).replace(/[^a-zA-Z0-9_-]/g, '-')
    return id && !Object.hasOwn(Object.prototype, id) && id !== 'prototype' ? id : fallback
}

function normalizeThreshold(value) {
    if (typeof value === 'boolean') return value
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

export function normalizeSource(input, index = 0) {
    const source = object(input)
    const type = SOURCE_TYPES.includes(source.type) ? source.type : 'custom'
    const interval = typeof source.intervalSeconds === 'boolean' ? NaN : Number(source.intervalSeconds)
    return {
        id: normalizeId(source.id, `source-${index + 1}`),
        label: string(source.label) || SOURCE_LABELS[type],
        type,
        enabled: source.enabled !== false,
        intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(MIN_INTERVAL, Math.ceil(interval)) : 60,
        url: string(source.url, 2048),
        slug: string(source.slug) || 'default',
        ipv4Url: string(source.ipv4Url, 2048),
        ipv6Url: string(source.ipv6Url, 2048),
        ipv4Enabled: source.ipv4Enabled !== false,
        ipv6Enabled: source.ipv6Enabled !== false,
        fields: uniqueById(list(source.fields).slice(0, 64).map((input, fieldIndex) => {
            const field = object(input)
            const path = string(field.path, 512)
            const fallback = `field-${fieldIndex + 1}`
            return {
                id: normalizeId(field.id, normalizeId(field.label || path, fallback)),
                label: string(field.label) || path || fallback,
                path,
                totalPath: string(field.totalPath, 512),
                unit: string(field.unit, 24),
                transform: ['count', 'ratio'].includes(field.transform) ? field.transform : 'value',
                warn: normalizeThreshold(field.warn),
                crit: normalizeThreshold(field.crit),
                direction: field.direction === 'below' ? 'below' : 'above',
            }
        })),
    }
}

export function normalizeConfig(input) {
    const config = object(input)
    const boxes = Array.isArray(config.boxes) ? config.boxes : DEFAULT_CONFIG.boxes
    return {
        demoMode: config.demoMode === true,
        demoOutage: config.demoOutage === true,
        chipEnabled: config.chipEnabled !== false,
        disabledSites: [...new Set(list(config.disabledSites).map(site => string(site).toLowerCase()).filter(Boolean))],
        asnEnabled: config.asnEnabled === true,
        rdnsEnabled: config.rdnsEnabled === true,
        notificationsEnabled: config.notificationsEnabled !== false,
        badge: { sourceId: string(object(config.badge).sourceId), metricId: string(object(config.badge).metricId) },
        boxes: uniqueById(boxes.slice(0, 16).map((input, index) => {
            const box = object(input)
            const id = normalizeId(box.id, `box-${index + 1}`)
            return {
                id,
                label: string(box.label) || id,
                enabled: box.enabled !== false,
                rows: list(box.rows).slice(0, 32).map(inputRow => {
                    const item = object(inputRow)
                    return { label: string(item.label), sourceId: string(item.sourceId), metricId: string(item.metricId) }
                }),
            }
        })),
        sources: uniqueById(list(config.sources).slice(0, 64).map(normalizeSource)),
    }
}

export function sourceUrl(value) {
    let url
    try {
        url = new URL(value)
    } catch {
        throw new Error('Enter a valid HTTP or HTTPS URL.')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP or HTTPS URL without embedded credentials.')
    }
    url.hash = ''
    return url
}

export function egressTargets(source) {
    return Object.entries(EGRESS_URLS).flatMap(([family, fallback]) => source[`${family}Enabled`] === false
        ? [] : [[family, source[`${family}Url`] || fallback]])
}

export function sourceOrigins(source) {
    if (source.type === 'claude') return [CLAUDE_ORIGIN]
    const urls = source.type === 'egress' ? egressTargets(source).map(([, url]) => url) : [source.url]
    return [...new Set(urls.map(value => `${sourceUrl(value).origin}/*`))]
}
