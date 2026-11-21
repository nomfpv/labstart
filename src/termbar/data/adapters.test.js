import { describe, expect, it, vi } from 'vitest'
import { mapCustom, readPath, runSource } from './adapters.js'
import { EGRESS_URLS, normalizeSource, sourceOrigins } from './config.js'

const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const source = (type, props = {}) => ({ type, url: 'https://status.example.com', ...props })

describe('custom JSON', () => {
    const fixture = {
        server: { load: 72.5, temps: [41, 46], healthy: false },
        containers: { active: ['web', 'db'], total: ['web', 'db', 'cache'] },
        directions: ['north', 'west'],
    }
    const fields = [
        { id: 'load', path: 'server.load', unit: '%', warn: '70', crit: '90' },
        { id: 'temp', path: 'server.temps[1]', unit: '°C' },
        { id: 'healthy', path: 'server.healthy', crit: false },
        { id: 'active', path: 'containers.active', transform: 'count' },
        { id: 'containers', path: 'containers.active', totalPath: 'containers.total', transform: 'ratio', direction: 'below', warn: 80, crit: 50 },
        { id: 'directions', path: 'directions' },
        { id: 'missing', path: 'nothing.here', warn: 3 },
    ]

    it('maps numbers, indices, booleans, arrays, counts, and ratios', () => {
        const metrics = mapCustom(fixture, normalizeSource(source('custom', { fields })).fields)
        expect(metrics).toMatchObject({
            load: { value: 72.5, unit: '%', severity: 'warn' },
            temp: { value: 46, unit: '°C', severity: 'ok' },
            healthy: { value: false, severity: 'crit' },
            active: { value: 2, sample: 2 },
            containers: { value: '2/3', sample: 66.7, severity: 'warn' },
            directions: { value: 'north, west', severity: 'ok' },
            missing: { value: null, severity: 'warn' },
        })
        expect(readPath(fixture, 'constructor.prototype')).toBeUndefined()
    })

    it('passes only the supplied header, blocks redirects, and redacts echoed values', async () => {
        const credential = 'sample value'
        const fetcher = vi.fn(async () => json({ ...fixture, echo: credential }))
        const result = await runSource(source('custom', { fields }), { headerName: 'X-Example', headerValue: credential }, { fetcher })
        expect(fetcher).toHaveBeenCalledWith('https://status.example.com/', expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
        expect(fetcher.mock.calls[0][1].headers.get('x-example')).toBe(credential)
        expect(result.raw.echo).toBe('[redacted]')
    })

    it('reports HTTP errors and unexpected JSON without exposing response body', async () => {
        const check = fetcher => runSource(source('custom', { fields }), {}, { fetcher })
        await expect(check(async () => json({ message: 'private response' }, 401))).rejects.toThrow('HTTP 401')
        await expect(check(async () => new Response('private response'))).rejects.toThrow('valid JSON')
    })
})

describe('Uptime Kuma', () => {
    it('counts distinct public monitors using their latest heartbeat', async () => {
        const page = { publicGroupList: [
            { monitorList: [{ id: 1 }, { id: 2 }, { id: 3 }] },
            { monitorList: [{ id: 2 }, { id: 4 }, { id: 5 }] },
        ] }
        const heartbeat = { heartbeatList: {
            1: [{ status: 0 }, { status: 1 }], 2: [{ status: 1 }, { status: 0 }],
            3: [{ status: 3 }], 4: [{ status: 2 }], 99: [{ status: 1 }],
        } }
        const fetcher = vi.fn(async url => json(url.includes('/heartbeat/') ? heartbeat : page))
        const result = await runSource(source('kuma', { url: 'https://status.example.com/kuma', slug: 'main' }), {}, { fetcher })
        expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/kuma/api/status-page/main', '/kuma/api/status-page/heartbeat/main',
        ])
        expect(result.metrics).toMatchObject({
            monitors: { value: '1 up / 1 down', severity: 'crit' },
            pending: { value: 2, severity: 'warn' }, maintenance: { value: 1 }, total: { value: 5 },
        })
    })
})

describe('AdGuard Home', () => {
    it('reads status and stats with basic auth and normalizes DNS metrics', async () => {
        const stats = { num_dns_queries: 1500, num_blocked_filtering: 240, avg_processing_time: 0.0032 }
        const status = { running: true, protection_enabled: false }
        const fetcher = vi.fn(async url => json(url.endsWith('/stats') ? stats : status))
        const username = 'operator'
        const password = ['sample', 'phrase'].join(' ')
        const result = await runSource(source('adguard'), { username, password }, { fetcher })
        expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/control/stats', '/control/status'])
        expect(fetcher.mock.calls.every(([, request]) => request.headers.get('authorization') === `Basic ${btoa(`${username}:${password}`)}`)).toBe(true)
        expect(result.metrics).toMatchObject({
            blocked: { value: 16, unit: '%' }, queries: { value: 1500 },
            protection: { value: false, severity: 'warn' }, dnsLatency: { value: 3.2, unit: 'ms' },
        })
    })
})

describe('own egress', () => {
    it('uses the default endpoints and tracks independent reachability', async () => {
        const fetcher = vi.fn(async url => url === EGRESS_URLS.ipv4
            ? new Response('ip=192.0.2.10\nhttp=http/2\n') : new Response('', { status: 503 }))
        const result = await runSource(source('egress'), {}, { fetcher })
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([EGRESS_URLS.ipv4, EGRESS_URLS.ipv6])
        expect(result.metrics).toMatchObject({
            ipv4: { value: true, severity: 'ok' }, ipv6: { value: false, severity: 'crit' },
            latency: { value: expect.any(Number), unit: 'ms' },
        })
    })

    it('supports a single custom family and reports a contradictory trace response', async () => {
        const ipv6Url = 'https://v6.example.com/trace'
        const config = source('egress', { ipv4Enabled: false, ipv6Url })
        const fetcher = vi.fn(async () => new Response('ip=192.0.2.10\n'))
        const result = await runSource(config, {}, { fetcher })
        expect(sourceOrigins(config)).toEqual(['https://v6.example.com/*'])
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ipv6Url])
        expect(result.metrics.ipv4).toBeUndefined()
        expect(result.metrics.ipv6).toMatchObject({ value: false, severity: 'crit' })
        expect(result.raw.ipv6.error).toContain('different address family')
    })
})

describe('unofficial Claude usage', () => {
    it('reads the chat organization using the existing site session', async () => {
        const orgs = [{ uuid: 'org-api', capabilities: ['api'] }, { uuid: 'org-chat', capabilities: ['chat'] }]
        const usage = { five_hour: { utilization: 47 }, seven_day: { utilization: 14 }, unused: null }
        const fetcher = vi.fn(async url => json(url.endsWith('/usage') ? usage : orgs))
        const result = await runSource(source('claude'), {}, { fetcher })
        expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/organizations', '/api/organizations/org-chat/usage'])
        expect(fetcher.mock.calls.every(([, request]) => request.credentials === 'include')).toBe(true)
        expect(result.metrics).toMatchObject({ usage: { value: 47, unit: '%' }, weekly: { value: 14, unit: '%' } })
    })

    it('returns errors for signed-out accounts and changed schemas', async () => {
        const check = fetcher => runSource(source('claude'), {}, { fetcher })
        await expect(check(async () => json({}, 401))).rejects.toThrow('Sign in to Claude')
        await expect(check(async () => json({}))).rejects.toThrow('organization response changed')
    })
})
