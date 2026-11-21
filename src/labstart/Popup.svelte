<script>
    import { onMount } from 'svelte'
    import StatusBoxes from './StatusBoxes.svelte'

    let extensions = $state([])
    let error = $state('')

    function icon(extension) {
        const icons = [...(extension.icons || [])].sort((a, b) => a.size - b.size)
        const url = (icons.find((item) => item.size >= 32) ?? icons.at(-1))?.url
        return url && !extension.enabled ? url + '?grayscale=true' : url
    }

    async function load() {
        const all = await chrome.management.getAll()
        extensions = all
            .filter((item) => item.type === 'extension' && item.id !== chrome.runtime.id)
            .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
    }

    async function toggle(extension, enabled) {
        error = ''
        try {
            await chrome.management.setEnabled(extension.id, enabled)
        } catch (failure) {
            error = `${extension.name}: ${failure.message}`
        }
        await load()
    }

    function open(url) {
        chrome.tabs.create({ url })
        window.close()
    }

    function settings() {
        chrome.runtime.openOptionsPage()
        window.close()
    }

    onMount(() => {
        load()
        const events = [chrome.management.onEnabled, chrome.management.onDisabled, chrome.management.onInstalled, chrome.management.onUninstalled]
        for (const event of events) event?.addListener(load)
        return () => { for (const event of events) event?.removeListener(load) }
    })
</script>

<main>
    <header>
        <span class="title">labstart</span>
        <nav>
            <button onclick={() => open('chrome://extensions/shortcuts')} title="extension shortcuts">keys</button>
            <button onclick={() => open('chrome://extensions')}>extensions</button>
            <button onclick={settings}>settings</button>
        </nav>
    </header>

    <StatusBoxes />

    <section class="panel-wrapper extensions" aria-label="extensions">
        <div class="panel-label">extensions</div>
        <ul class="panel">
            {#each extensions as extension (extension.id)}
                <li class:off={!extension.enabled}>
                    <button class="name" onclick={() => open(extension.optionsUrl)} disabled={!extension.optionsUrl || !extension.enabled}
                        title={extension.optionsUrl ? `open ${extension.name} settings` : `${extension.name} has no settings page`}>
                        {#if icon(extension)}<img src={icon(extension)} alt="" width="16" height="16" />{/if}
                        <span>{extension.name}</span>
                    </button>
                    <input type="checkbox" role="switch" checked={extension.enabled} disabled={!extension.mayDisable}
                        aria-label={`${extension.enabled ? 'disable' : 'enable'} ${extension.name}`}
                        onchange={(event) => toggle(extension, event.currentTarget.checked)} />
                </li>
            {/each}
        </ul>
    </section>
    {#if error}<p class="error">{error}</p>{/if}
</main>

<style>
    :global(body.popup) { width: 34rem; font-size: 13px; }
    main { padding: 0.9rem 1rem 1.1rem; display: grid; gap: 1.4rem; }
    header { display: flex; justify-content: space-between; align-items: baseline; }
    .title { color: var(--txt-1); }
    nav { display: flex; gap: 0.9rem; }
    nav button { background: none; border: none; padding: 0; color: var(--txt-3); font: inherit; cursor: pointer; }
    nav button:hover, nav button:focus-visible { color: var(--txt-1); }
    main :global(.status-boxes) { gap: 1.4rem 1rem; }
    main :global(.status-boxes .panel) { padding: 0.8rem 0.9rem; }
    main :global(.status-boxes section) { min-width: 14rem; }
    ul.panel {
        list-style: none; margin: 0; padding: 0.7rem 0.8rem;
        display: grid; grid-template-columns: 1fr 1fr; gap: 0.15rem 1.2rem;
    }
    li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; min-width: 0; }
    li.off .name { color: var(--txt-4); }
    .name {
        display: flex; align-items: center; gap: 0.5rem; min-width: 0; padding: 0.2rem 0;
        background: none; border: none; color: var(--txt-2); font: inherit; text-align: left; cursor: pointer;
    }
    .name:disabled { cursor: default; }
    .name:not(:disabled):hover span { color: var(--txt-1); text-decoration: underline; text-underline-offset: 3px; }
    .name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name img { flex: none; }
    input[role='switch'] {
        appearance: none; flex: none; width: 1.7rem; height: 0.9rem; margin: 0; position: relative; cursor: pointer;
        border: 1px solid var(--bg-3); background: var(--bg-2);
    }
    input[role='switch']::after {
        content: ''; position: absolute; top: 1px; left: 1px; width: calc(0.9rem - 4px); height: calc(0.9rem - 4px);
        background: var(--txt-4); transition: transform 120ms ease;
    }
    input[role='switch']:checked::after { transform: translateX(0.8rem); background: var(--txt-2); }
    input[role='switch']:disabled { opacity: 0.4; cursor: default; }
    .error { margin: 0; color: var(--txt-err); }
    @media (prefers-reduced-motion: reduce) { input[role='switch']::after { transition: none; } }
</style>
