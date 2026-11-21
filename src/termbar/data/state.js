const LEVEL = { ok: 0, warn: 1, crit: 2 }
const SAMPLE_LIMIT = 32
export const ALERT_DEBOUNCE_MS = 1200

export function worstSeverity(values) {
    return values.reduce((highest, value) => LEVEL[value] > LEVEL[highest] ? value : highest, 'ok')
}

export function thresholdSeverity(value, { warn, crit, direction = 'above' } = {}) {
    if (typeof value !== 'boolean' && !Number.isFinite(value)) return 'ok'
    const crosses = threshold => {
        if (typeof threshold === 'boolean') return value === threshold
        if (!Number.isFinite(threshold)) return false
        return direction === 'below' ? Number(value) <= threshold : Number(value) >= threshold
    }
    if (crosses(crit)) return 'crit'
    return crosses(warn) ? 'warn' : 'ok'
}

export function metric(label, value, unit = '', severity = 'ok', sample = value) {
    return { label, value, unit, severity, sample }
}

export function sourceSnapshot(label, result, previous, checkedAt, failureSeverity = 'crit') {
    if (result.error) {
        return { label, checkedAt, error: result.error, severity: failureSeverity, metrics: previous?.metrics ?? {} }
    }

    const metrics = Object.fromEntries(Object.entries(result.metrics).map(([id, { sample, ...value }]) => {
        const history = previous?.metrics[id]?.history ?? []
        return [id, { ...value, history: Number.isFinite(sample) ? [...history, sample].slice(-SAMPLE_LIMIT) : history }]
    }))
    return { label, checkedAt, error: null, severity: worstSeverity(Object.values(metrics).map(value => value.severity)), metrics }
}

export function makeState(sources = {}, updatedAt = 0, demo = false) {
    return { updatedAt, demo, severity: worstSeverity(Object.values(sources).map(source => source.severity)), sources }
}

export const EMPTY_STATE = makeState()

export function queueAlert(previous, severity, now) {
    const last = previous?.last ?? 'ok'
    if (last === severity) return { last, pending: null }
    if (previous?.pending?.severity === severity) return previous
    return { last, pending: { severity, dueAt: now + ALERT_DEBOUNCE_MS } }
}

export function takeAlert(alert, now) {
    if (!alert?.pending || alert.pending.dueAt > now) return null
    return { last: alert.pending.severity, pending: null }
}
