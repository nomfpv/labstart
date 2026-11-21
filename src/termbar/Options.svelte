<script>
    import { onMount } from 'svelte'
    import {
        CONFIG_KEY, EGRESS_URLS, MIN_INTERVAL, RIPE_ORIGIN, SECRETS_KEY,
        SOURCE_LABELS, SOURCE_TYPES, WEB_ORIGINS, normalizeConfig, normalizeSource, sourceOrigins,
    } from './data/config.js'
    import { runSource } from './data/adapters.js'

    let config = $state(normalizeConfig())
    let secrets = $state({})
    let sourceTests = $state({})
    let hostsAllowed = $state(false)
    let status = $state('')
    let failure = $state(false)
    let busy = $state(false)
    let ready = $state(false)
    let importInput = $state()
    let siteText = $state('')

    const knownMetrics = {
        kuma: ['monitors', 'up', 'down', 'total'],
        adguard: ['blocked', 'queries', 'protection', 'dnsLatency'],
        egress: ['ipv4', 'ipv6', 'latency'],
        claude: ['usage', 'weekly'],
    }
    const metricIds = new Set(['load', 'temp', 'containers', 'tunnels', 'monitors', 'blocked',
        ...Object.values(knownMetrics).flat()])
    const fieldDefaults = () => ({ label: '', id: '', path: '', totalPath: '', unit: '', transform: 'value', warn: null, crit: null, direction: 'above' })

    function setStatus(message, isFailure = false) {
        status = message
        failure = isFailure
    }

    async function refreshAccess() {
        hostsAllowed = await chrome.permissions.contains({ origins: WEB_ORIGINS })
    }

    onMount(() => {
        if (!globalThis.chrome?.runtime?.id) {
            setStatus('Open this page from the installed extension.', true)
            return
        }
        chrome.storage.local.get([CONFIG_KEY, SECRETS_KEY]).then((data) => {
            config = normalizeConfig(data[CONFIG_KEY])
            secrets = data[SECRETS_KEY] || {}
            for (const source of config.sources) secrets[source.id] ||= {}
            siteText = config.disabledSites.join('\n')
            ready = true
        }).catch(() => setStatus('Could not load extension settings.', true))
        refreshAccess().catch(() => {})
        chrome.permissions.onAdded.addListener(refreshAccess)
        chrome.permissions.onRemoved.addListener(refreshAccess)
        return () => {
            chrome.permissions.onAdded.removeListener(refreshAccess)
            chrome.permissions.onRemoved.removeListener(refreshAccess)
        }
    })

    function addSource() {
        if (!ready) return
        const id = crypto.randomUUID()
        secrets[id] = {}
        config.sources.push(normalizeSource({ id, type: 'custom', fields: [fieldDefaults()] }))
    }

    function removeSource(id) {
        config.sources = config.sources.filter((source) => source.id !== id)
        delete sourceTests[id]
        delete secrets[id]
        for (const box of config.boxes) {
            for (const row of box.rows) if (row.sourceId === id) row.sourceId = ''
        }
    }

    function setType(source, type) {
        if (!source.label || source.label === SOURCE_LABELS[source.type]) source.label = SOURCE_LABELS[type]
        source.type = type
        if (type === 'custom' && !source.fields.length) source.fields.push(fieldDefaults())
        delete sourceTests[source.id]
    }

    function moveBox(index, step) {
        const boxes = [...config.boxes]
        const [box] = boxes.splice(index, 1)
        boxes.splice(index + step, 0, box)
        config.boxes = boxes
    }

    function editedConfig() {
        const domains = siteText.split(/[\n,]+/).map((name) => name.trim()).filter(Boolean).map((name) => {
            try {
                return new URL(name.includes('://') ? name : 'https://' + name).hostname
            } catch {
                throw new Error('Enter one valid hostname per line.')
            }
        })
        return normalizeConfig({ ...config, disabledSites: domains })
    }

    async function save() {
        busy = true
        try {
            const value = editedConfig()
            const origins = [...new Set([
                ...value.sources.filter((source) => source.enabled).flatMap(sourceOrigins),
                ...(value.asnEnabled ? [RIPE_ORIGIN] : []),
            ])]
            if (origins.length && !await chrome.permissions.request({ origins })) {
                throw new Error('Grant access to the configured sources to save.')
            }
            const localSecrets = Object.fromEntries(value.sources.flatMap((source) => {
                const secret = secrets[source.id] || {}
                const fields = source.type === 'adguard' ? ['username', 'password']
                    : source.type === 'custom' ? ['headerName', 'headerValue'] : []
                const values = fields.filter((key) => secret[key]).map((key) => [key, secret[key]])
                return values.length ? [[source.id, Object.fromEntries(values)]] : []
            }))
            await chrome.storage.local.set({ [CONFIG_KEY]: value, [SECRETS_KEY]: localSecrets })
            config = value
            siteText = value.disabledSites.join('\n')
            setStatus('Saved.')
        } catch (error) {
            setStatus(error.message, true)
        } finally {
            busy = false
        }
    }

    async function setDemo(event, key) {
        config[key] = event.currentTarget.checked
        if (!config.demoMode) config.demoOutage = false
        const { demoMode, demoOutage } = config
        try {
            const data = await chrome.storage.local.get(CONFIG_KEY)
            await chrome.storage.local.set({
                [CONFIG_KEY]: { ...normalizeConfig(data[CONFIG_KEY]), demoMode, demoOutage },
            })
            setStatus(demoOutage && demoMode ? 'Demo outage enabled.' : 'Demo setting saved.')
        } catch {
            setStatus('Could not update demo mode.', true)
        }
    }

    async function changeAccess() {
        try {
            if (hostsAllowed) await chrome.permissions.remove({ origins: WEB_ORIGINS })
            else if (!await chrome.permissions.request({ origins: WEB_ORIGINS })) return
            await refreshAccess()
            setStatus(hostsAllowed ? 'Website overlays enabled.' : 'Website overlays disabled.')
        } catch {
            setStatus('Could not change website access.', true)
        }
    }

    function showSafeResult(value, secret) {
        let text = JSON.stringify(value, null, 2) ?? ''
        for (const key of ['headerValue', 'password']) {
            if (secret[key]) text = text.split(secret[key]).join('[redacted]')
        }
        return text
    }

    async function testSource(source) {
        const clean = normalizeSource(source)
        const id = clean.id
        const secret = $state.snapshot(secrets[id] || {})
        sourceTests[id] = { pending: true }
        try {
            const origins = sourceOrigins(clean)
            if (origins.length && !await chrome.permissions.request({ origins })) {
                throw new Error('Grant access to test this source.')
            }
            const { raw, metrics } = await runSource(clean, secret)
            sourceTests[id] = { raw: showSafeResult(raw, secret), mapped: showSafeResult(metrics, secret) }
        } catch (error) {
            sourceTests[id] = { error: error.message }
        }
    }

    function exportConfig() {
        try {
            const blob = new Blob([JSON.stringify(editedConfig(), null, 2) + '\n'], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = 'termbar-config.json'
            link.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            setStatus('Configuration exported.')
        } catch (error) {
            setStatus(error.message, true)
        }
    }

    async function importConfig(event) {
        const file = event.currentTarget.files[0]
        event.currentTarget.value = ''
        if (!file) return
        try {
            const value = JSON.parse(await file.text())
            if (!value || typeof value !== 'object' || Array.isArray(value) ||
                !Array.isArray(value.sources) || !Array.isArray(value.boxes)) throw new Error()
            const next = normalizeConfig(value)
            const previous = new Map(config.sources.map((source) => [source.id, source]))
            secrets = Object.fromEntries(next.sources.map((source) => {
                const prior = previous.get(source.id)
                const sameEndpoint = prior?.type === source.type && prior.url === source.url
                return [source.id, sameEndpoint ? secrets[source.id] || {} : {}]
            }))
            config = next
            sourceTests = {}
            siteText = config.disabledSites.join('\n')
            setStatus('Configuration loaded. Save to apply it.')
        } catch {
            setStatus('Choose a valid termbar configuration JSON file.', true)
        }
    }
</script>

<main class="options">
    <header>
        <h1>termbar options</h1>
        <nav aria-label="termbar">
            <a href="./index.html">new tab</a>
            <a href="./hud.html">HUD</a>
            <button class="primary" onclick={save} disabled={!ready || busy}>save</button>
        </nav>
    </header>
    <div class="layout">
        <div class="stack">
            <section class="panel-wrapper">
                <h2 class="panel-label">overlays</h2>
                <div class="panel flow">
                    <button onclick={changeAccess} disabled={!ready}>{hostsAllowed ? 'disable website overlays' : 'enable website overlays'}</button>
                    <p class="hint">Website access lets termbar read main-document connection details and display the chip and alert line.</p>
                    <label><input type="checkbox" bind:checked={config.chipEnabled} /> show site chip</label>
                    <label><input type="checkbox" bind:checked={config.notificationsEnabled} /> outage notifications</label>
                    <label><input type="checkbox" bind:checked={config.asnEnabled} /> resolve ASN using RIPEstat</label>
                    <p class="hint">RIPEstat receives visited sites’ remote IP addresses when this is enabled.</p>
                    <label>hide chip on these sites <textarea rows="3" placeholder="example.com" bind:value={siteText}></textarea></label>
                </div>
            </section>
            <section class="panel-wrapper">
                <h2 class="panel-label">demo</h2>
                <div class="panel flow">
                    <label><input type="checkbox" checked={config.demoMode} onchange={(event) => setDemo(event, 'demoMode')} disabled={!ready} /> demo mode</label>
                    <label><input type="checkbox" checked={config.demoOutage} onchange={(event) => setDemo(event, 'demoOutage')} disabled={!ready || !config.demoMode} /> simulate outage</label>
                    <p class="hint">Uses sample metrics and connection details. Live source polling pauses.</p>
                </div>
            </section>
            <section class="panel-wrapper">
                <h2 class="panel-label">configuration</h2>
                <div class="panel flow">
                    <input type="file" accept=".json,application/json" hidden bind:this={importInput} onchange={importConfig} />
                    <div class="toolbar">
                        <button onclick={() => importInput.click()} disabled={!ready}>import JSON</button>
                        <button onclick={exportConfig} disabled={!ready}>export JSON</button>
                    </div>
                    <p class="hint">Credentials stay in local extension storage. Exports contain source settings and box mappings.</p>
                </div>
            </section>
        </div>

        <div class="stack">
            <section class="panel-wrapper">
                <h2 class="panel-label">sources</h2>
                <div class="panel flow">
                    {#each config.sources as source (source.id)}
                        <details class="card" open>
                            <summary>{source.label}</summary>
                            <div class="flow">
                                <div class="form-grid">
                                    <label>type
                                        <select value={source.type} onchange={(event) => setType(source, event.currentTarget.value)}>
                                            {#each SOURCE_TYPES as type}<option value={type}>{SOURCE_LABELS[type]}</option>{/each}
                                        </select>
                                    </label>
                                    <label>name <input bind:value={source.label} /></label>
                                    <label>interval (seconds) <input type="number" min={MIN_INTERVAL} step="1" bind:value={source.intervalSeconds} /></label>
                                    <label><input type="checkbox" bind:checked={source.enabled} /> enabled</label>
                                </div>
                                {#if source.type === 'egress'}
                                    <div class="form-grid">
                                        <label><input type="checkbox" bind:checked={source.ipv4Enabled} /> IPv4</label>
                                        <label><input type="checkbox" bind:checked={source.ipv6Enabled} /> IPv6</label>
                                        <label>IPv4 trace URL <input type="url" placeholder={EGRESS_URLS.ipv4} bind:value={source.ipv4Url} disabled={!source.ipv4Enabled} /></label>
                                        <label>IPv6 trace URL <input type="url" placeholder={EGRESS_URLS.ipv6} bind:value={source.ipv6Url} disabled={!source.ipv6Enabled} /></label>
                                    </div>
                                {:else if source.type === 'claude'}
                                    <p class="hint">Unofficial. Uses the current claude.ai session. Sign in there before testing. Endpoint changes can make this source unavailable.</p>
                                {:else}
                                    <label>{source.type === 'custom' ? 'JSON URL' : 'server URL'}
                                        <input type="url" placeholder="https://status.example.com/metrics" bind:value={source.url} />
                                    </label>
                                    {#if source.type === 'kuma'}
                                        <label>status page slug <input bind:value={source.slug} /></label>
                                    {:else if source.type === 'adguard'}
                                        <div class="form-grid">
                                            <label>username <input autocomplete="off" bind:value={secrets[source.id].username} /></label>
                                            <label>password <input type="password" autocomplete="off" bind:value={secrets[source.id].password} /></label>
                                        </div>
                                    {:else if source.type === 'custom'}
                                        <div class="form-grid">
                                            <label>header name <input placeholder="X-Token" bind:value={secrets[source.id].headerName} /></label>
                                            <label>header value <input type="password" autocomplete="off" bind:value={secrets[source.id].headerValue} /></label>
                                        </div>
                                        <h3>field mapping</h3>
                                        <div class="field-list">
                                            {#each source.fields as field, index}
                                                <div class="form-grid card">
                                                    <label>metric ID <input placeholder="temp" bind:value={field.id} /></label>
                                                    <label>label <input placeholder="temperature" bind:value={field.label} /></label>
                                                    <label>JSON path <input placeholder="cpu.temperature" bind:value={field.path} /></label>
                                                    <label>unit <input placeholder="°C" bind:value={field.unit} /></label>
                                                    <label>value mode
                                                        <select bind:value={field.transform}><option value="value">value</option><option value="count">array count</option><option value="ratio">part / total</option></select>
                                                    </label>
                                                    {#if field.transform === 'ratio'}
                                                        <label>total path <input placeholder="containers.total" bind:value={field.totalPath} /></label>
                                                    {/if}
                                                    <label>warning <input type="number" step="any" bind:value={field.warn} /></label>
                                                    <label>critical <input type="number" step="any" bind:value={field.crit} /></label>
                                                    <label>threshold direction <select bind:value={field.direction}><option value="above">at or above</option><option value="below">at or below</option></select></label>
                                                    <div class="toolbar"><button onclick={() => source.fields.splice(index, 1)}>remove field</button></div>
                                                </div>
                                            {/each}
                                        </div>
                                        <p class="hint">Use dot paths or array indexes. For booleans, use 0 for false and 1 for true. Ratio thresholds use percentages.</p>
                                        <div><button onclick={() => source.fields.push(fieldDefaults())}>add field</button></div>
                                    {/if}
                                {/if}
                                <div class="toolbar">
                                    <button onclick={() => testSource(source)} disabled={sourceTests[source.id]?.pending}>test source</button>
                                    <button onclick={() => removeSource(source.id)}>remove source</button>
                                </div>
                                {#if sourceTests[source.id]?.pending}
                                    <p role="status">testing…</p>
                                {:else if sourceTests[source.id]?.error}
                                    <p class="error" role="status">{sourceTests[source.id].error}</p>
                                {:else if sourceTests[source.id]}
                                    <details open><summary>mapped values</summary><pre>{sourceTests[source.id].mapped}</pre></details>
                                    <details><summary>raw response</summary><pre>{sourceTests[source.id].raw}</pre></details>
                                {/if}
                            </div>
                        </details>
                    {/each}
                    {#if !config.sources.length}<p class="hint">Add a source to fill the new-tab boxes and HUD with live data.</p>{/if}
                    <div><button onclick={addSource} disabled={!ready}>add source</button></div>
                </div>
            </section>

            <section class="panel-wrapper">
                <h2 class="panel-label">new-tab boxes</h2>
                <div class="panel flow">
                    {#each config.boxes as box, index (box.id)}
                        <div class="flow card">
                            <div class="box-header">
                                <label><input type="checkbox" bind:checked={box.enabled} /> {box.label}</label>
                                <div class="toolbar">
                                    <button aria-label={'move ' + box.label + ' up'} disabled={index === 0} onclick={() => moveBox(index, -1)}>↑</button>
                                    <button aria-label={'move ' + box.label + ' down'} disabled={index === config.boxes.length - 1} onclick={() => moveBox(index, 1)}>↓</button>
                                </div>
                            </div>
                            {#each box.rows as row, rowIndex}
                                <div class="row-fields">
                                    <label>row name <input bind:value={row.label} /></label>
                                    <label>source
                                        <select bind:value={row.sourceId}>
                                            <option value="">auto</option>
                                            {#each config.sources as source}<option value={source.id}>{source.label}</option>{/each}
                                        </select>
                                    </label>
                                    <label>metric ID <input list="metric-ids" bind:value={row.metricId} /></label>
                                    <button aria-label={'remove ' + row.label + ' row'} onclick={() => box.rows.splice(rowIndex, 1)}>×</button>
                                </div>
                            {/each}
                            <div><button onclick={() => box.rows.push({ label: '', sourceId: '', metricId: '' })}>add row</button></div>
                        </div>
                    {/each}
                    <datalist id="metric-ids">
                        {#each metricIds as id}<option value={id}></option>{/each}
                        {#each config.sources as source}
                            {#each source.fields as field}
                                {#if field.id}<option value={field.id}></option>{/if}
                            {/each}
                        {/each}
                    </datalist>
                </div>
            </section>
        </div>
    </div>
    <p role="status" class="status" class:failure>{status}</p>
</main>
