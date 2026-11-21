<script>
    import { onMount } from 'svelte'
    import { CONFIG_KEY, DEFAULT_CONFIG, normalizeConfig, STATE_KEY } from './data/config.js'
    import { boxMetric, boxSeverity, displayedBoxes, formatMetric, sparkPath } from './metrics.js'

    let config = $state(DEFAULT_CONFIG)
    let state = $state(null)
    let boxes = $derived(displayedBoxes(config, state))

    // A box with a single percentage row is drawn as a full-width gauge strip.
    const isGauge = (box) => box.rows.length === 1 && boxMetric(state, box.rows[0])?.unit === '%'
    const percent = (metric) => Math.max(0, Math.min(100, Number(metric?.value) || 0))

    onMount(() => {
        if (!globalThis.chrome?.storage) return
        const changed = (changes, area) => {
            if (area === 'local' && changes[CONFIG_KEY]) config = normalizeConfig(changes[CONFIG_KEY].newValue)
            if (area === 'session' && changes[STATE_KEY]) state = changes[STATE_KEY].newValue
        }
        chrome.storage.onChanged.addListener(changed)
        chrome.storage.local.get(CONFIG_KEY).then((data) => config = normalizeConfig(data[CONFIG_KEY]))
        chrome.storage.session.get(STATE_KEY).then((data) => state = data[STATE_KEY])
        return () => chrome.storage.onChanged.removeListener(changed)
    })
</script>

{#if boxes.length}
    <div class="status-boxes" aria-label="labstart status">
        {#each boxes as box (box.id)}
            {@const severity = boxSeverity(state, box)}
            <section class="panel-wrapper" class:gauge={isGauge(box)} aria-label={box.label}>
                <div class="panel-label">
                    {box.label}{#if severity !== 'ok'}<span class="mark {severity}" title={severity}> ●</span>{/if}
                </div>
                <dl class="panel">
                    {#each box.rows as row}
                        {@const metric = boxMetric(state, row)}
                        {@const level = metric?.severity}
                        <div class="row" title={metric?.error}>
                            <dt>{row.label}</dt>
                            {#if isGauge(box)}
                                <span class="bar {level}" aria-hidden="true"><span style="width: {percent(metric)}%"></span></span>
                            {:else}
                                {@const path = sparkPath(metric?.history)}
                                <span class="spark {level}" aria-hidden="true">
                                    {#if path}
                                        <svg viewBox="0 0 100 20" preserveAspectRatio="none">
                                            <path class="area" d={path.area} />
                                            <path class="line" d={path.line} />
                                        </svg>
                                    {/if}
                                </span>
                            {/if}
                            <dd class={level}>{formatMetric(metric)}</dd>
                        </div>
                    {/each}
                </dl>
            </section>
        {/each}
    </div>
{/if}

<style>
    .status-boxes { display: flex; flex-wrap: wrap; gap: 1.5rem; }
    section { flex: 1 1 0; min-width: min(100%, 15rem); }
    section.gauge { flex-basis: 100%; }
    .panel { margin: 0; padding: 1rem 1.25rem; min-width: 0; display: grid; gap: 0.15rem; align-content: start; }
    .row {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr) max-content;
        gap: 0.9rem;
        align-items: center;
        min-height: 1.55em;
    }
    dt { color: var(--txt-2); white-space: nowrap; }
    dd { color: var(--txt-1); margin: 0; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .spark { display: flex; justify-content: flex-end; height: 1.1em; color: var(--txt-3); }
    .spark svg { width: min(100%, 7.5rem); height: 100%; overflow: visible; }
    .spark .line { fill: none; stroke: currentColor; stroke-width: 1.25; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
    .spark .area { fill: currentColor; opacity: 0.12; }
    .bar {
        position: relative;
        height: 0.55rem;
        background: repeating-linear-gradient(90deg, var(--bg-3) 0 0.4rem, transparent 0.4rem 0.55rem);
    }
    .bar > span {
        position: absolute;
        inset: 0 auto 0 0;
        background: repeating-linear-gradient(90deg, var(--txt-3) 0 0.4rem, transparent 0.4rem 0.55rem);
        transition: width 600ms ease;
    }
    .warn { color: var(--labstart-warn); }
    .crit { color: var(--txt-err); }
    .bar.warn > span { background: repeating-linear-gradient(90deg, var(--labstart-warn) 0 0.4rem, transparent 0.4rem 0.55rem); }
    .bar.crit > span { background: repeating-linear-gradient(90deg, var(--txt-err) 0 0.4rem, transparent 0.4rem 0.55rem); }
    .mark { font-size: 0.7em; vertical-align: 0.15em; }
    @media (prefers-reduced-motion: reduce) { .bar > span { transition: none; } }
</style>
