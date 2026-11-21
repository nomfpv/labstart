import { makeState, metric, sourceSnapshot } from './state.js'

export const DEMO_SITE = {
    ip: '2001:db8::24', family: 'v6', asn: 64500, org: 'example edge', cdn: 'example edge',
    protocol: 'h3', ttfb: 14, connect: 3,
}

export function demoState(now, outage) {
    const step = Math.floor(now / 30_000)
    const wave = (base, amplitude, offset) => Array.from({ length: 24 }, (_, index) => {
        const angle = (step + index + offset) / 2
        return Math.round((base + amplitude * (Math.sin(angle) + 0.4 * Math.cos(2.7 * angle))) * 10) / 10
    })
    const series = (label, unit, base, amplitude, offset, severity = 'ok', override) => {
        const history = wave(base, amplitude, offset)
        if (override !== undefined) history[history.length - 1] = override
        return { label, unit, severity, value: history.at(-1), history }
    }
    const demoSource = (label, metrics) => sourceSnapshot(label, { metrics }, null, now)
    const status = outage ? 'crit' : 'ok'
    const homelab = demoSource('homelab', {
        containers: metric('containers', outage ? '15/18' : '18/18', '', status, outage ? 15 : 18),
        tunnels: metric('tunnels', '3/3', '', 'ok', 3),
        monitors: metric('monitors', outage ? '5/6 up' : '6/6 up', '', status, outage ? 5 : 6),
    })
    homelab.metrics = {
        load: series('load', '%', 28, 11, 0, status, outage ? 94 : undefined),
        temp: series('temp', '°C', 45, 4, 3),
        traffic: series('traffic', 'Mb/s', 102, 40, 5),
        ...homelab.metrics,
    }
    const net = demoSource('net', { ipv4: metric('ipv4', true), ipv6: metric('ipv6', true) })
    net.metrics.latency = series('latency', 'ms', 14, 3, 15)
    net.metrics.blocked = series('dns blocked', '%', 21, 2, 8)
    const claude = demoSource('claude', {})
    claude.metrics.usage = series('5-hour usage', '%', 48, 4, 19)
    return makeState({ 'demo-homelab': homelab, 'demo-net': net, 'demo-claude': claude }, now, true)
}
