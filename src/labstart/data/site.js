const RIPE_ENDPOINT = 'https://stat.ripe.net/data/prefix-overview/data.json'
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
const LOOKUP_LIMIT = 256 * 1024

async function limitedJson(response, name) {
    const text = await response.text()
    if (text.length > LOOKUP_LIMIT) throw new Error(`${name} response is too large.`)
    return JSON.parse(text)
}
const CDN = { 13335: 'cloudflare', 54113: 'fastly', 20940: 'akamai', 16625: 'akamai', 16509: 'amazon' }
const BANNED_V4_FIRST = new Set([0, 10, 127])

function ipv4Address(address) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null
    const parts = address.split('.').map(Number)
    return parts.every(value => value <= 255) ? parts : null
}

function ipv6Address(address) {
    if (!address.includes(':') || !/^[\da-f:.]+$/i.test(address)) return null
    let canonical
    try {
        canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    } catch {
        return null
    }
    const [front, back] = canonical.split('::')
    const first = front ? front.split(':') : []
    const last = back ? back.split(':') : []
    const missing = back === undefined ? [] : Array(8 - first.length - last.length).fill('0')
    return [...first, ...missing, ...last].map(value => parseInt(value, 16))
}

export function ipFamily(address) {
    if (typeof address !== 'string') return null
    if (ipv4Address(address)) return 'v4'
    return ipv6Address(address) ? 'v6' : null
}

export function publicAddress(address) {
    if (typeof address !== 'string') return false
    const v4 = ipv4Address(address)
    if (v4) {
        const [a, b] = v4
        return !BANNED_V4_FIRST.has(a) && a < 224 && !(a === 100 && b >= 64 && b <= 127)
            && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    }
    const v6 = ipv6Address(address)
    return Boolean(v6 && (v6[0] & 0xe000) === 0x2000)
}

function ipNumber(address) {
    const v4 = ipv4Address(address)
    const parts = v4 ?? ipv6Address(address)
    if (!parts) return null
    const step = v4 ? 8n : 16n
    return { bits: v4 ? 32 : 128, value: parts.reduce((result, part) => (result << step) | BigInt(part), 0n) }
}

export function prefixContains(prefix, address) {
    const [base, length] = prefix.split('/')
    const network = ipNumber(base)
    const ip = ipNumber(address)
    if (!network || !ip || network.bits !== ip.bits) return false
    const bits = length === undefined ? network.bits : Number(length)
    if (!Number.isInteger(bits) || bits < 0 || bits > network.bits) return false
    const shift = BigInt(network.bits - bits)
    return (network.value >> shift) === (ip.value >> shift)
}

export function cachedAsn(cache, ip, now) {
    const matches = Object.entries(cache).filter(([prefix, record]) => record.expires > now && prefixContains(prefix, ip))
    // A host-only entry has no prefix length and is the most specific match.
    return matches.sort(([a], [b]) => (Number(b.split('/')[1]) || 129) - (Number(a.split('/')[1]) || 129))[0]?.[1]
}

export async function fetchAsn(ip, { fetcher = fetch } = {}) {
    const url = new URL(RIPE_ENDPOINT)
    url.searchParams.set('resource', ip)
    const response = await fetcher(url.href, {
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`RIPEstat returned HTTP ${response.status}.`)
    const { data } = await limitedJson(response, 'RIPEstat')
    const record = data?.announced ? data.asns?.[0] : null
    const asn = Number(record?.asn)
    if (!Number.isInteger(asn) || asn < 1) return { prefix: ip, asn: null, org: null, cdn: null }
    const prefix = typeof data.resource === 'string' && prefixContains(data.resource, ip) ? data.resource : ip
    return { prefix, asn, org: typeof record.holder === 'string' ? record.holder.slice(0, 100) : null, cdn: CDN[asn] ?? null }
}

export function ptrName(ip) {
    const v4 = ipv4Address(ip)
    if (v4) return [...v4].reverse().join('.') + '.in-addr.arpa'
    const v6 = ipv6Address(ip)
    if (!v6) return null
    const nibbles = v6.map(part => part.toString(16).padStart(4, '0')).join('')
    return [...nibbles].reverse().join('.') + '.ip6.arpa'
}

export async function fetchPtr(ip, { fetcher = fetch } = {}) {
    const name = ptrName(ip)
    if (!name) return null
    const url = new URL(DOH_ENDPOINT)
    url.searchParams.set('name', name)
    url.searchParams.set('type', 'PTR')
    const response = await fetcher(url.href, {
        credentials: 'omit', redirect: 'error', headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`DNS lookup returned HTTP ${response.status}.`)
    const answer = (await limitedJson(response, 'DNS')).Answer?.find(record => record.type === 12)
    return typeof answer?.data === 'string' ? answer.data.replace(/\.$/, '').slice(0, 253) || null : null
}

export function normalizeTiming(timing) {
    const duration = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null
    return {
        protocol: typeof timing?.protocol === 'string' ? timing.protocol.slice(0, 32) : '',
        ttfb: duration(timing?.ttfb),
        connect: duration(timing?.connect),
        timeOrigin: duration(timing?.timeOrigin),
    }
}

export function navigationMatches(record, sender, timing) {
    if (!record) return false
    if (record.documentId && record.documentId === sender.documentId) return true
    const urlWithoutHash = url => url?.split('#', 1)[0]
    return urlWithoutHash(record.url) === urlWithoutHash(sender.url)
        && (!timing.timeOrigin || record.timeStamp >= timing.timeOrigin - 50)
}

export function siteSnapshot(ip, timing, asn) {
    const family = ipFamily(ip)
    return {
        ip: family ? ip : null, family, asn: asn?.asn ?? null, org: asn?.org ?? null, cdn: asn?.cdn ?? null,
        protocol: timing.protocol, ttfb: timing.ttfb, connect: timing.connect,
    }
}
