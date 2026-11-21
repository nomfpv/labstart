import '@fontsource-variable/geist-mono'
import '../app.css'
import { mount } from 'svelte'
import { applySavedTheme } from './theme.js'
import Popup from './Popup.svelte'

applySavedTheme()
mount(Popup, { target: document.querySelector('#app') })
