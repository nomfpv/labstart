import { egressTargets, normalizeSource, sourceUrl } from './config.js'
import { metric, thresholdSeverity } from './state.js'

const REQUEST_TIMEOUT = 10_000
const RESPONSE_LIMIT = 1024 * 1024
const CLAUDE_API = 'https://claude.ai/api/organizations'
const finite = value => typeof value === 'number' && Number.isFinite(value)
const round = value => Math.round(value * 10) / 10

class SourceError extends Error {}

async function responseText(response) {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let body = ''
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return body + decoder.decode()
            size += value.byteLength
            if (size > RESPONSE_LIMIT) {
                await reader.cancel()
                throw new SourceError('The source response exceeded 1 MiB.')
            }
            body += decoder.decode(value, { stream: true })
        }
    } finally {
        reader.releaseLock()
    }
}

async function read(fetcher, url, { headers, credentials = 'omit', text = false, authError } = {}) {
    try {
        const response = await fetcher(url, {
            method: 'GET', cache: 'no-store', credentials, redirect: 'manual', headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        })
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            throw new SourceError('The source redirected. Enter the final URL (for example https:// instead of http://).')
        }
        if (authError && [401, 403].includes(response.status)) throw new SourceError(authError)
        if (!response.ok) throw new SourceError(`The source returned HTTP ${response.status}.`)
        const body = await responseText(response)
        if (text) return body
        try {
            return JSON.parse(body)
        } catch {
            throw new SourceError('The source did not return valid JSON.')
        }
    } catch (error) {
        if (error instanceof SourceError) throw error
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new SourceError('The source timed out.')
        throw new SourceError('Could not reach the source. Check its URL, browser access, and network connection.')
    }
}

function endpoint(base, path) {
    const url = sourceUrl(base)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`
    return url.href
}

export function readPath(value, path) {
    const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    return segments.reduce((node, key) => node && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined, value)
}

function numberValue(value) {
    if (typeof value === 'boolean') return Number(value)
    if (finite(value)) return value
    if (typeof value !== 'string' || !value.trim()) return null
    const number = Number(value)
    return finite(number) ? number : null
}

function scalar(value) {
    if (finite(value) || typeof value === 'boolean') return value
    if (typeof value === 'string') return value.slice(0, 100)
    if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
        return value.slice(0, 12).join(', ').slice(0, 100)
    }
    return null
}

// Accepts "3 of 5", "3/5" and "3 / 5" as an amount and a total.
export function fraction(value) {
    if (typeof value !== 'string') return null
    const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*(?:of|\/)\s*(\d+(?:\.\d+)?)\s*$/i)
    return match ? { amount: Number(match[1]), total: Number(match[2]) } : null
}

function count(value) {
    return Array.isArray(value) ? value.length : numberValue(value)
}

export function mapCustom(raw, fields) {
    return Object.fromEntries(fields.map(field => {
        const value = readPath(raw, field.path)
        let display = scalar(value)
        let sample = typeof value === 'boolean' ? value : numberValue(value)
        if (field.transform === 'count') display = sample = count(value)
        const parts = fraction(value)
        if (parts && field.transform !== 'count') {
            display = `${parts.amount}/${parts.total}`
            sample = parts.total > 0 ? round(parts.amount * 100 / parts.total) : null
        } else if (field.transform === 'ratio') {
            const amount = count(value)
            const total = count(readPath(raw, field.totalPath))
            display = amount !== null && total !== null ? `${amount}/${total}` : null
            sample = display !== null && total > 0 ? round(amount * 100 / total) : null
        }
        const severity = display === null && (field.warn !== null || field.crit !== null)
            ? 'warn' : thresholdSeverity(sample, field)
        return [field.id, metric(field.label, display, field.unit, severity, sample)]
    }))
}

function customHeaders({ headerName, headerValue }) {
    if (!headerName && !headerValue) return undefined
    if (!headerName || !headerValue) throw new SourceError('Enter both an HTTP header name and value.')
    try {
        return new Headers({ [headerName]: headerValue })
    } catch {
        throw new SourceError('The HTTP header name or value is invalid.')
    }
}

function redactCredentials(value, secretValues) {
    if (typeof value === 'string') {
        return secretValues.reduce((result, token) => {
            if (result === token) return '[redacted]'
            return token.length >= 4 ? result.replaceAll(token, '[redacted]') : result
        }, value)
    }
    if (Array.isArray(value)) return value.map(item => redactCredentials(item, secretValues))
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredentials(item, secretValues)]))
    }
    return value
}

async function custom(source, secret, fetcher) {
    const headers = customHeaders(secret)
    const response = await read(fetcher, sourceUrl(source.url).href, { headers })
    const supplied = [secret.headerValue, secret.headerValue?.match(/^Bearer (.+)$/i)?.[1]].filter(Boolean)
    const raw = redactCredentials(response, supplied)
    return { raw, metrics: mapCustom(raw, source.fields) }
}

async function kuma(source, _secret, fetcher) {
    const slug = encodeURIComponent(source.slug)
    const [page, heartbeat] = await Promise.all([
        read(fetcher, endpoint(source.url, `api/status-page/${slug}`)),
        read(fetcher, endpoint(source.url, `api/status-page/heartbeat/${slug}`)),
    ])
    if (!Array.isArray(page?.publicGroupList) || !heartbeat?.heartbeatList || typeof heartbeat.heartbeatList !== 'object') {
        throw new SourceError('The Uptime Kuma status page response was not recognized.')
    }
    const ids = new Set(page.publicGroupList.flatMap(group => group.monitorList ?? []).map(monitor => monitor.id))
    const totals = { up: 0, down: 0, pending: 0, maintenance: 0 }
    for (const id of ids) {
        const list = heartbeat.heartbeatList[id]
        const code = Array.isArray(list) ? list.at(-1)?.status : undefined
        const status = ['down', 'up', 'pending', 'maintenance'][code] ?? 'pending'
        totals[status]++
    }
    const { up, down, pending, maintenance } = totals
    const severity = down ? 'crit' : pending ? 'warn' : 'ok'
    return {
        raw: { page, heartbeat },
        metrics: {
            monitors: metric('monitors', `${up}/${up + down} up`, '', severity, up),
            up: metric('up', up), down: metric('down', down, '', down ? 'crit' : 'ok'),
            pending: metric('pending', pending, '', pending ? 'warn' : 'ok'),
            maintenance: metric('maintenance', maintenance), total: metric('total', ids.size),
        },
    }
}

function basicHeader({ username, password }) {
    if (!username && !password) return undefined
    const bytes = new TextEncoder().encode(`${username ?? ''}:${password ?? ''}`)
    const credentials = String.fromCharCode(...bytes)
    return new Headers({ Authorization: `Basic ${btoa(credentials)}` })
}

async function adguard(source, secret, fetcher) {
    const headers = basicHeader(secret)
    const [stats, status] = await Promise.all([
        read(fetcher, endpoint(source.url, 'control/stats'), { headers }),
        read(fetcher, endpoint(source.url, 'control/status'), { headers }),
    ])
    const queries = stats?.num_dns_queries
    const blocked = stats?.num_blocked_filtering
    const protection = status?.protection_enabled
    if (!finite(queries) || !finite(blocked) || typeof protection !== 'boolean') {
        throw new SourceError('The AdGuard Home stats or status response was not recognized.')
    }
    const raw = redactCredentials({ stats, status }, [secret.username, secret.password].filter(Boolean))
    return {
        raw,
        metrics: {
            blocked: metric('dns blocked', queries ? round(blocked * 100 / queries) : 0, '%'),
            queries: metric('queries', queries),
            protection: metric('protection', protection, '', protection ? 'ok' : 'warn', Number(protection)),
            dnsLatency: metric('dns latency', finite(stats.avg_processing_time) ? round(stats.avg_processing_time * 1000) : null, 'ms'),
        },
    }
}

async function egress(source, _secret, fetcher) {
    const targets = egressTargets(source)
    if (!targets.length) throw new SourceError('Enable at least one address family.')
    const results = await Promise.all(targets.map(async ([family, value]) => {
        const url = sourceUrl(value).href
        const start = performance.now()
        try {
            const body = await read(fetcher, url, { text: true })
            const ip = /(?:^|\n)ip=([^\r\n]+)/.exec(body)?.[1]
            if (ip && ip.includes(':') !== (family === 'ipv6')) {
                throw new SourceError('The endpoint reported a different address family.')
            }
            return [family, { body, reachable: true, latency: Math.round(performance.now() - start) }]
        } catch (error) {
            return [family, { error: error.message, reachable: false, latency: null }]
        }
    }))
    const metrics = Object.fromEntries(results.flatMap(([family, result]) => {
        const { reachable, latency } = result
        return [
            [family, metric(family, reachable, '', reachable ? 'ok' : 'crit', Number(reachable))],
            [`${family}Latency`, metric(`${family} latency`, latency, 'ms')],
        ]
    }))
    const latencies = results.map(([, result]) => result.latency).filter(finite)
    metrics.latency = metric('latency', latencies.length ? Math.min(...latencies) : null, 'ms')
    return { raw: Object.fromEntries(results), metrics }
}

async function claude(_source, _secret, fetcher) {
    const authError = 'Sign in to Claude in this browser, then retry the unofficial usage source.'
    const options = { credentials: 'include', authError }
    const orgs = await read(fetcher, CLAUDE_API, options)
    if (!Array.isArray(orgs)) throw new SourceError('The unofficial Claude organization response changed.')
    const chat = orgs.find(org => Array.isArray(org?.capabilities) && org.capabilities.includes('chat') && org.uuid)
    if (!chat) throw new SourceError('No Claude chat organization is available for this account.')
    const raw = await read(fetcher, `${CLAUDE_API}/${encodeURIComponent(chat.uuid)}/usage`, options)
    const recent = raw?.five_hour?.utilization
    const weekly = raw?.seven_day?.utilization
    if (!finite(recent) && !finite(weekly)) throw new SourceError('The unofficial Claude usage response changed.')
    return {
        raw,
        metrics: {
            ...(finite(recent) ? { usage: metric('5-hour usage', recent, '%') } : {}),
            ...(finite(weekly) ? { weekly: metric('weekly usage', weekly, '%') } : {}),
        },
    }
}

const adapters = { custom, kuma, adguard, egress, claude }

export function runSource(input, secret = {}, { fetcher = fetch } = {}) {
    const source = normalizeSource(input)
    return adapters[source.type](source, secret ?? {}, fetcher)
}
