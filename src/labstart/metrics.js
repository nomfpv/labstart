export function boxMetric(state, row) {
    const sources = state?.sources || {}
    const source = row.sourceId && !state?.demo
        ? sources[row.sourceId]
        : Object.values(sources).find((source) => source.metrics?.[row.metricId])
    const metric = source?.metrics?.[row.metricId]
    if (source?.error) return { ...metric, error: source.error, severity: source.severity }
    return metric
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false })

export function formatMetric(metric) {
    const value = metric?.value
    if (value == null) return '—'
    if (typeof value === 'boolean') return value ? 'yes' : 'no'
    const text = typeof value === 'number' ? numberFormat.format(value) : String(value)
    if (!metric.unit) return text
    return text + (metric.unit === '%' || metric.unit.startsWith('°') ? '' : ' ') + metric.unit
}

export function displayedBoxes(config, state) {
    return config.boxes.filter((box) => box.enabled && (
        box.id !== 'claude' || config.demoMode || config.sources.some((source) => source.enabled && source.type === 'claude') ||
        box.rows.some((row) => boxMetric(state, row)?.value != null)
    ))
}

// SVG path data for a small line chart in a width x height box, plus the filled area under it.
export function sparkPath(history, width = 100, height = 20, length = 24) {
    const points = (history || []).filter(Number.isFinite).slice(-length)
    if (points.length < 2) return null
    const min = Math.min(...points)
    const spread = Math.max(...points) - min || 1
    const step = width / (points.length - 1)
    const coords = points.map((value, index) => [
        Math.round(index * step * 10) / 10,
        Math.round((height - 1.5 - (value - min) * (height - 3) / spread) * 10) / 10,
    ])
    const line = 'M' + coords.map(([x, y]) => `${x} ${y}`).join('L')
    return { line, area: `${line}L${width} ${height}L0 ${height}Z` }
}

const LEVEL = { ok: 0, warn: 1, crit: 2 }
export function boxSeverity(state, box) {
    return box.rows.reduce((worst, row) => {
        const severity = boxMetric(state, row)?.severity
        return LEVEL[severity] > LEVEL[worst] ? severity : worst
    }, 'ok')
}
