<script>
    import '@fontsource-variable/geist-mono'
    import 'virtual:simple-icons.css'
    import { settings } from './lib/stores/settings-store.svelte.js'
    import Clock from './lib/components/Clock.svelte'
    import Links from './lib/components/Links.svelte'
    import Stats from './lib/components/Stats.svelte'
    import Tasks from './lib/components/Tasks.svelte'
    import Weather from './lib/components/Weather.svelte'
    import { saveSettings } from './lib/stores/settings-store.svelte.js'
    import { isChrome } from './lib/utils/browser-detect.js'
    import { applyTheme, publishTheme } from './termbar/theme.js'
    import { toggleHud, isHudShortcut } from './termbar/pip.js'
    import StatusBoxes from './termbar/StatusBoxes.svelte'

    let showSettings = $state(false)
    let Settings = $state(null)
    let settingsError = $state(false)

    // Check if Google Tasks is available (Chrome only)
    const googleTasksAvailable = isChrome()

    let needsConfiguration = $derived(
        (settings.showWeather &&
            settings.locationMode === 'manual' &&
            (settings.latitude === null || settings.longitude === null)) ||
            (settings.showTasks &&
                settings.taskBackend === 'todoist' &&
                !settings.todoistApiToken) ||
            (settings.showTasks &&
                settings.taskBackend === 'google-tasks' &&
                googleTasksAvailable &&
                !settings.googleTasksSignedIn)
    )

    function closeSettings() {
        showSettings = false
    }

    async function openSettings() {
        showSettings = true
        settingsError = false
        try {
            Settings ??= (await import('./lib/components/Settings.svelte')).default
        } catch {
            showSettings = false
            settingsError = true
        }
    }

    function handleGlobalKeydown(event) {
        if (isHudShortcut(event)) {
            event.preventDefault()
            toggleHud().catch(() => chrome.runtime.sendMessage({ type: 'termbar:open-launcher' }).catch(() => {}))
            return
        }
        if (showSettings) return
        if (!settings.linkHotkeys) return
        if (event.ctrlKey || event.altKey || event.metaKey) return

        const target = event.target
        const isTypingField = target.tagName === 'INPUT' ||
                              target.tagName === 'TEXTAREA' ||
                              target.isContentEditable

        if (isTypingField) return

        const link = settings.links.find((l) => l.hotkey === event.key)
        if (link && link.url) {
            event.preventDefault()
            event.stopPropagation()

            if (settings.linkTarget === '_blank') {
                window.open(link.url, '_blank', 'noopener,noreferrer')
            } else {
                window.location.assign(link.url)
            }
        }
    }

    $effect(() => {
        applyTheme(settings)
        publishTheme()
    })

    $effect(() => {
        document.title = settings.tabTitle || '~'
    })

    $effect(() => {
        let styleEl = document.getElementById('custom-css')
        if (!styleEl) {
            styleEl = document.createElement('style')
            styleEl.id = 'custom-css'
            document.head.appendChild(styleEl)
        }
        styleEl.textContent = settings.customCSS || ''
    })

    $effect(() => {
        saveSettings(settings)
    })
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<main>
    <div class="container">
        {#if settings.showClock || settings.showStats}
            <div class="top">
                {#if settings.showClock}
                    <Clock />
                {/if}
                {#if settings.showStats}
                    <Stats class={!settings.showClock ? 'expand' : ''} />
                {/if}
            </div>
        {/if}
        {#if settings.showWeather || settings.showTasks}
            <div class="widgets">
                {#if settings.showWeather}
                    <Weather class={!settings.showTasks ? 'expand' : ''} />
                {/if}
                {#if settings.showTasks}
                    <Tasks />
                {/if}
            </div>
        {/if}
        <StatusBoxes />
        {#if settings.showLinks}
            <Links />
        {/if}
    </div>

    <nav aria-label="settings">
        <a href="./options.html">termbar</a>
        <button class:needs-config={needsConfiguration} onclick={openSettings}>
            settings
        </button>
    </nav>

    {#if Settings}
        <Settings {showSettings} {closeSettings} />
    {/if}
    {#if settingsError}
        <p class="error" role="alert">Could not open settings. Reload this tab and try again.</p>
    {/if}
</main>

<style>
    main {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
        justify-content: center;
        align-items: center;
        padding: 2rem 1rem;
    }
    .container {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }
    .top,
    .widgets {
        display: flex;
        gap: 1.5rem;
    }
    nav {
        position: fixed;
        top: 0;
        right: 0;
        display: flex;
        gap: 1.25rem;
        padding: 1rem 1.5rem;
        z-index: 100;
        color: var(--txt-3);
    }
    nav a:hover, nav button:hover {
        color: var(--txt-1);
    }
    .needs-config {
        color: var(--txt-2);
    }
    @media (max-width: 40rem) {
        main { align-items: stretch; padding-top: 3.5rem; }
        .top, .widgets { flex-wrap: wrap; }
    }
</style>
