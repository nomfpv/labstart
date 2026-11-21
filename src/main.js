import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { applySavedTheme } from './labstart/theme.js'
import { installHudTrigger } from './labstart/pip.js'

applySavedTheme()
if (globalThis.chrome?.runtime?.id) installHudTrigger()

const app = mount(App, {
    target: document.getElementById('app'),
})

export default app
