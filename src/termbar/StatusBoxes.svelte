<script>
    import { onMount } from 'svelte'
    import { CONFIG_KEY, DEFAULT_CONFIG, normalizeConfig, STATE_KEY } from './data/config.js'
    import { boxMetric, displayedBoxes, formatMetric } from './metrics.js'

    let config = $state(DEFAULT_CONFIG)
    let state = $state(null)
    let boxes = $derived(displayedBoxes(config, state))

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
    <div class="status-boxes" aria-label="termbar status">
        {#each boxes as box (box.id)}
            <section class="panel-wrapper" aria-label={box.label}>
                <div class="panel-label">{box.label}</div>
                <dl class="panel">
                    {#each box.rows as row}
                        {@const metric = boxMetric(state, row)}
                        <div class="row">
                            <dt>{row.label}</dt>
                            <dd title={metric?.error} class:warn={metric?.severity === 'warn'} class:crit={metric?.severity === 'crit'}>
                                {formatMetric(metric)}
                            </dd>
                        </div>
                        {#if box.id === 'claude' && typeof metric?.value === 'number'}
                            <meter aria-label={row.label} min="0" max="100" value={metric.value}></meter>
                        {/if}
                    {/each}
                </dl>
            </section>
        {/each}
    </div>
{/if}

<style>
    .status-boxes { display: flex; flex-wrap: wrap; gap: 1.5rem; }
    section { flex: 1 1 13rem; }
    .panel { margin: 0; padding: 1rem 1.25rem; min-width: 0; }
    .row { display: flex; justify-content: space-between; gap: 0.8rem; align-items: baseline; }
    dt { color: var(--txt-2); }
    dd { color: var(--txt-1); margin: 0; text-align: right; overflow-wrap: anywhere; }
    .warn { color: var(--termbar-warn); }
    .crit { color: var(--txt-err); }
    meter { width: 100%; height: 0.65rem; accent-color: var(--txt-3); }
    meter::-webkit-meter-bar { border: 0; border-radius: 0; background: var(--bg-3); }
    meter::-webkit-meter-optimum-value { background: var(--txt-3); }
</style>
