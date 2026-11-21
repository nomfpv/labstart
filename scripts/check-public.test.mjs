import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { readPrivatePatterns, scanFile, scanText } from './check-public.mjs'

const liveV4 = [172, 20, 5, 12].join('.')
const liveV6 = ['fd12', '', '4321'].join(':')
const secret = ['ghp', 'a'.repeat(32)].join('_')

function pngChunk(type, data) {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(data.length)
    header.write(type, 4, 'ascii')
    return Buffer.concat([header, data, Buffer.alloc(4)])
}

describe('public file scan', () => {
    it('allows documentation addresses and the sample lab IP', () => {
        expect(scanText('192.0.2.10 198.51.100.1 203.0.113.9 10.66.66.2 [2001:0db8::1] [3fff:12::1]').size).toBe(0)
    })

    it('flags private or public addresses and credentials without displaying values', () => {
        expect(scanText(liveV4 + ' [' + liveV6 + '] token: "' + secret + '"')).toEqual(new Set([
            'IPv4 address', 'IPv6 address', 'credential pattern',
        ]))
        expect(scanText('http://' + liveV4 + ':4312/path')).toContain('IPv4 address')
        expect(scanText('http://[::ffff:' + liveV4 + ']:4312/path')).toContain('IPv6 address')
    })

    it('supports literal and regex patterns and rejects malformed regexes', () => {
        const patterns = readPrivatePatterns('# comment\nsample.thing\nre:asset-[0-9]{3}\n')
        expect(scanText('sample.thing', patterns)).toContain('private pattern')
        expect(scanText('asset-321', patterns)).toContain('private pattern')
        expect(scanText('sample-thing', patterns).size).toBe(0)
        expect(() => readPrivatePatterns('re:[')).toThrow('Invalid regular expression')
    })

    it('checks plain and compressed PNG metadata', () => {
        const data = Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            pngChunk('tEXt', Buffer.from('Comment\0' + liveV4)),
            pngChunk('zTXt', Buffer.concat([Buffer.from('Info\0\0'), deflateSync(secret)])),
            pngChunk('IEND', Buffer.alloc(0)),
        ])
        expect(scanFile(data)).toEqual(new Set(['image metadata: IPv4 address', 'image metadata: credential pattern']))
    })
})
