import '@fontsource-variable/geist-mono'
import '../app.css'
import './options.css'
import { mount } from 'svelte'
import { applySavedTheme, publishTheme } from './theme.js'
import Options from './Options.svelte'

applySavedTheme()
publishTheme()
window.addEventListener('storage', (event) => {
    if (event.key === 'settings') applySavedTheme()
})
mount(Options, { target: document.querySelector('#app') })
