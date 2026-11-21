import { describe, expect, it, vi } from 'vitest'
import { cachedAsn, fetchAsn, ipFamily, navigationMatches, normalizeTiming, prefixContains, publicAddress, siteSnapshot } from './site.js'

describe('site telemetry', () => {
    it('distinguishes address families and never invents an IP for cached navigations', () => {
        expect(ipFamily('192.0.2.10')).toBe('v4')
        expect(ipFamily('2001:db8::1')).toBe('v6')
        expect(ipFamily('300.0.2.10')).toBeNull()
        expect(ipFamily('2001::db8::1')).toBeNull()
        expect(publicAddress('10.66.66.2')).toBe(false)
        expect(siteSnapshot(null, normalizeTiming({ protocol: 'h3', ttfb: 14.1, connect: 2.3 }))).toMatchObject({
            ip: null, family: null, protocol: 'h3', ttfb: 14, connect: 2,
        })
    })

    it('matches by document ID or verified navigation time and URL', () => {
        const record = { documentId: 'first', timeStamp: 1000, url: 'https://example.com/' }
        expect(navigationMatches(record, { documentId: 'first', url: 'https://example.com/other' }, {})).toBe(true)
        expect(navigationMatches(record, { url: 'https://example.com/#anchor' }, { timeOrigin: 900 })).toBe(true)
        expect(navigationMatches(record, { url: 'https://example.com/' }, { timeOrigin: 2000 })).toBe(false)
    })
})

describe('RIPEstat', () => {
    it('normalizes a prefix lookup and scopes cache matches to that covering prefix', async () => {
        const asn = { asn: 64500, holder: 'Example Network' }
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: {
            announced: true, resource: '192.0.2.0/25', asns: [asn],
        } })))
        const result = await fetchAsn('192.0.2.10', { fetcher })
        expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('resource')).toBe('192.0.2.10')
        expect(result).toEqual({ prefix: '192.0.2.0/25', asn: 64500, org: 'Example Network', cdn: null })
        const cache = { [result.prefix]: { ...result, expires: 200 } }
        expect(cachedAsn(cache, '192.0.2.105', 100)?.asn).toBe(64500)
        expect(cachedAsn(cache, '192.0.2.190', 100)).toBeUndefined()
        expect(cachedAsn(cache, '192.0.2.105', 200)).toBeUndefined()
        expect(prefixContains('2001:db8::/64', '2001:0db8:0:0:0:0:0:4')).toBe(true)
        expect(prefixContains('2001:db8::/64', '2001:db8:0:1::4')).toBe(false)
    })
})
