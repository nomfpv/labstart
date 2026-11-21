import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { simpleIconsVirtualModules } from './plugins/simple-icons-virtual-modules.js'

const manifest = JSON.parse(readFileSync(new URL('./public/manifest.json', import.meta.url), 'utf8'))

export default defineConfig({
    base: './',
    plugins: [simpleIconsVirtualModules(), svelte()],
    define: { __APP_VERSION__: JSON.stringify(manifest.version) },
    build: {
        outDir: 'dist/chrome',
        sourcemap: false,
        rolldownOptions: {
            input: {
                index: 'index.html',
                options: 'options.html',
                popup: 'popup.html',
                background: 'src/labstart/worker.js',
            },
            output: { entryFileNames: '[name].js' },
        },
    },
})
