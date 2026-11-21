import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { applySavedTheme } from './termbar/theme.js'
import { installHudTrigger } from './termbar/pip.js'

applySavedTheme()
if (globalThis.chrome?.runtime?.id) installHudTrigger()

const app = mount(App, {
    target: document.getElementById('app'),
})

export default app
