import { describe, expect, it } from 'vitest'
import { normalizeConfig, normalizeSource, sourceOrigins } from './config.js'
import { DEMO_SITE, demoState } from './demo.js'
import { ALERT_DEBOUNCE_MS, makeState, metric, queueAlert, sourceSnapshot, takeAlert, thresholdSeverity } from './state.js'

describe('configuration normalization', () => {
    it('keeps box order, leaves optional networking disabled, and clamps poll intervals', () => {
        expect(normalizeConfig()).toMatchObject({ demoMode: false, asnEnabled: false, sources: [] })
        expect(normalizeConfig({ boxes: [{ id: 'net' }, { id: 'homelab' }] }).boxes.map(box => box.id)).toEqual(['net', 'homelab'])
        expect(normalizeSource({ intervalSeconds: 12 }).intervalSeconds).toBe(30)
        expect(normalizeSource({ intervalSeconds: 85.5 }).intervalSeconds).toBe(86)
        expect(sourceOrigins({ type: 'custom', url: 'http://status.example.com:8080/metrics' })).toEqual(['http://status.example.com:8080/*'])
        expect(() => sourceOrigins({ type: 'custom', url: 'file:///fixture.json' })).toThrow('HTTP or HTTPS')
    })
})

describe('thresholds and state', () => {
    it('uses inclusive boundaries, evaluates critical first, and supports below and booleans', () => {
        expect(thresholdSeverity(45, { warn: 40, crit: 45 })).toBe('crit')
        expect(thresholdSeverity(40, { warn: 40, crit: 45 })).toBe('warn')
        expect(thresholdSeverity(20, { warn: 30, crit: 10, direction: 'below' })).toBe('warn')
        expect(thresholdSeverity(false, { crit: false })).toBe('crit')
        expect(thresholdSeverity(true, { crit: false })).toBe('ok')
        expect(thresholdSeverity(null, { crit: 0, direction: 'below' })).toBe('ok')
    })

    it('caps histories, keeps measurements on failure, and publishes the highest severity', () => {
        let latest
        for (let sample = 0; sample < 40; sample++) {
            latest = sourceSnapshot('generator', { metrics: { load: metric('load', sample, '%') } }, latest, sample)
        }
        expect(latest.metrics.load.history).toEqual(Array.from({ length: 32 }, (_, index) => index + 8))
        const failed = sourceSnapshot('generator', { error: 'Could not connect.' }, latest, 40)
        expect(failed.metrics).toEqual(latest.metrics)
        expect(makeState({ test: failed })).toMatchObject({ severity: 'crit', sources: { test: { checkedAt: 40 } } })
    })

    it('debounces transitions and queues each stable state only once', () => {
        const start = 1000
        const pending = queueAlert(undefined, 'crit', start)
        expect(queueAlert(pending, 'crit', start + 100)).toEqual(pending)
        expect(takeAlert(pending, start + ALERT_DEBOUNCE_MS - 1)).toBeNull()
        expect(queueAlert(pending, 'ok', start + 200)).toEqual({ last: 'ok', pending: null })
        const sent = takeAlert(pending, start + ALERT_DEBOUNCE_MS)
        expect(sent).toEqual({ last: 'crit', pending: null })
        expect(queueAlert(sent, 'crit', start + 10000)).toEqual(sent)
        expect(queueAlert(sent, 'ok', start + 10000).pending.severity).toBe('ok')
    })

    it('provides synthetic status, history, site telemetry, and a reproducible outage', () => {
        const healthy = demoState(30000, false)
        const outage = demoState(30000, true)
        expect(healthy.severity).toBe('ok')
        expect(outage.severity).toBe('crit')
        expect(healthy.sources['demo-homelab'].metrics.load.history).toHaveLength(24)
        expect(demoState(60000, false).sources['demo-net'].metrics.latency.history).not.toEqual(healthy.sources['demo-net'].metrics.latency.history)
        expect(DEMO_SITE).toMatchObject({ family: 'v6', protocol: 'h3' })
    })
})
