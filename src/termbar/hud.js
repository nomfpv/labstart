import '@fontsource-variable/geist-mono'
import '../app.css'
import './hud.css'
import { applySavedTheme } from './theme.js'
import { installHudTrigger, isHudShortcut, toggleHud } from './pip.js'

applySavedTheme()
installHudTrigger()
window.addEventListener('storage', (event) => {
    if (event.key === 'settings') applySavedTheme()
})

const button = document.querySelector('#toggle')
const status = document.querySelector('#status')
async function toggle() {
    try {
        const open = await toggleHud()
        button.textContent = open ? 'close floating HUD' : 'open floating HUD'
        status.textContent = 'Alt+Shift+H'
        if (open) window.documentPictureInPicture.window.addEventListener('pagehide', () => {
            button.textContent = 'open floating HUD'
        }, { once: true })
    } catch (error) {
        status.textContent = error.message
    }
}
button.addEventListener('click', toggle)
window.addEventListener('keydown', (event) => {
    if (isHudShortcut(event)) {
        event.preventDefault()
        toggle()
    }
})
