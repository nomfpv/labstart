import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ipv4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g
const ipv6 = /(?<![\w:])(?=[\da-f:]*:)[\da-f:]+(?:\d\.\d{1,3}\.\d{1,3}\.\d{1,3})?(?![\w:])/gi
const ipv4Examples = /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.66\.66\.2$)/
// Public anycast endpoints the extension uses on purpose (Cloudflare trace for the egress check).
const publicEndpoints = new Set(['1.1.1.1', '2606:4700:4700::1111'])
const ipv6Examples = /^(?:2001:0?db8:|3fff:(?:[0-9a-f]{1,3}:|:))/i
const mac = /\b[\da-f]{2}(?::[\da-f]{2}){5}\b|\b[\da-f]{2}(?:-[\da-f]{2}){5}\b/i
const tokens = [
    /\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|npm_|hf_|sk-(?:proj-|ant-)?|rk_live_|sk_live_)[\w-]{16,}/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[\w-]{35}\b/,
    /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{12,}\b/,
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=-]{16,}\b/i,
    /(?:^|[^\w])["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|client[_-]?secret|password|passwd|secret[_-]?key)["']?\s*[:=]\s*(?:["'][^"'\r\n]{8,}["']|[A-Za-z0-9+/_-]{24,})/i,
]

export function readPrivatePatterns(text) {
    return text.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((line) => {
        if (!line.trim() || line.trimStart().startsWith('#')) return []
        if (!line.startsWith('re:')) return [(input) => input.includes(line)]
        try {
            const regex = new RegExp(line.slice(3), 'u')
            return [(input) => regex.test(input)]
        } catch {
            throw new Error('Invalid regular expression in .private-patterns')
        }
    })
}

export function scanText(text, privatePatterns = []) {
    const hits = new Set()
    if ([...text.matchAll(ipv4)].some(([value]) => isIP(value) === 4 && !ipv4Examples.test(value) && !publicEndpoints.has(value))) {
        hits.add('IPv4 address')
    }
    if ([...text.matchAll(ipv6)].some(([value]) =>
        value !== '::' && isIP(value) === 6 && !ipv6Examples.test(value) && !publicEndpoints.has(value.toLowerCase()))) {
        hits.add('IPv6 address')
    }
    if (mac.test(text)) hits.add('MAC address')
    if (tokens.some((pattern) => pattern.test(text))) hits.add('credential pattern')
    if (privatePatterns.some((matches) => matches(text))) hits.add('private pattern')
    return hits
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function* pngMetadata(buffer) {
    for (let offset = 8; offset + 12 <= buffer.length;) {
        const length = buffer.readUInt32BE(offset)
        const end = offset + 8 + length
        if (end + 4 > buffer.length) throw new Error('Malformed PNG data')
        const type = buffer.toString('ascii', offset + 4, offset + 8)
        const content = buffer.subarray(offset + 8, end)
        offset = end + 4
        if (type === 'IEND') break
        if (type === 'tEXt' || type === 'eXIf') yield content
        if (type === 'zTXt' || type === 'iCCP') {
            const nul = content.indexOf(0)
            if (nul < 0) throw new Error('Malformed PNG metadata')
            yield content.subarray(0, nul)
            yield inflateSync(content.subarray(nul + 2), { maxOutputLength: 16 << 20 })
        }
        if (type === 'iTXt') {
            const keywordEnd = content.indexOf(0)
            const langEnd = content.indexOf(0, keywordEnd + 3)
            const translatedEnd = content.indexOf(0, langEnd + 1)
            if (keywordEnd < 0 || langEnd < 0 || translatedEnd < 0) throw new Error('Malformed PNG metadata')
            yield content.subarray(0, translatedEnd)
            const data = content.subarray(translatedEnd + 1)
            yield content[keywordEnd + 1] ? inflateSync(data, { maxOutputLength: 16 << 20 }) : data
        }
    }
}

function* jpegMetadata(buffer) {
    let offset = 2
    while (offset + 4 <= buffer.length && buffer[offset++] === 0xff) {
        while (buffer[offset] === 0xff) offset++
        const marker = buffer[offset++]
        if (marker === 0xda || marker === 0xd9) break
        const length = buffer.readUInt16BE(offset)
        if (length < 2 || offset + length > buffer.length) throw new Error('Malformed JPEG metadata')
        if (marker === 0xfe || marker >= 0xe0 && marker <= 0xef) {
            yield buffer.subarray(offset + 2, offset + length)
        }
        offset += length
    }
}

function* webpMetadata(buffer) {
    for (let offset = 12; offset + 8 <= buffer.length;) {
        const size = buffer.readUInt32LE(offset + 4)
        const end = offset + 8 + size
        if (end > buffer.length) throw new Error('Malformed WebP metadata')
        if (['EXIF', 'XMP ', 'ICCP'].includes(buffer.toString('ascii', offset, offset + 4))) {
            yield buffer.subarray(offset + 8, end)
        }
        offset = end + (size % 2)
    }
}

export function scanFile(buffer, privatePatterns = []) {
    let metadata
    if (buffer.subarray(0, 8).equals(pngSignature)) metadata = pngMetadata(buffer)
    else if (buffer[0] === 0xff && buffer[1] === 0xd8) metadata = jpegMetadata(buffer)
    else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        metadata = webpMetadata(buffer)
    }
    if (!metadata) return scanText(buffer.toString('utf8'), privatePatterns)
    const hits = new Set()
    for (const value of metadata) {
        const texts = [value.toString('utf8'), value.toString('latin1')]
        // EXIF and XMP can contain UTF-16 at either byte alignment.
        for (let offset = 0; offset <= 1; offset++) {
            const aligned = value.subarray(offset, value.length - ((value.length - offset) % 2))
            texts.push(aligned.toString('utf16le'), Buffer.from(aligned).swap16().toString('utf16le'))
        }
        for (const text of texts) {
            for (const hit of scanText(text, privatePatterns)) hits.add('image metadata: ' + hit)
        }
    }
    return hits
}

function checkPublic(staged) {
    const git = (args, options) => execFileSync('git', args, { maxBuffer: 64 << 20, ...options })
    const root = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const fromRoot = (args, options) => git(args, { cwd: root, ...options })
    const files = fromRoot(['ls-files', '-z', '--cached'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    let patterns = []
    try {
        patterns = readPrivatePatterns(readFileSync(join(root, '.private-patterns'), 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }

    let failed = false
    for (const file of new Set(files)) {
        const filenameHits = scanText(file, patterns)
        const displayName = filenameHits.size ? '[redacted filename]' : file
        const input = staged ? fromRoot(['show', ':' + file]) : readFileSync(join(root, file))
        const hits = new Set([...filenameHits, ...scanFile(input, patterns)])
        if (!hits.size) continue
        failed = true
        console.error(displayName + ' — ' + [...hits].join(', '))
    }
    if (failed) return 1
    console.log('Public check passed.')
    return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = checkPublic(new Set(process.argv.slice(2)).has('--staged'))
    } catch (error) {
        console.error('Public check could not run. ' + error.message)
        process.exitCode = 1
    }
}
