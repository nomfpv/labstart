export function boxMetric(state, row) {
    const sources = state?.sources || {}
    const source = row.sourceId && !state?.demo
        ? sources[row.sourceId]
        : Object.values(sources).find((source) => source.metrics?.[row.metricId])
    const metric = source?.metrics?.[row.metricId]
    if (source?.error) return { ...metric, error: source.error, severity: source.severity }
    return metric
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

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
