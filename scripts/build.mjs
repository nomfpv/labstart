import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { build } from 'vite'

const outDir = 'dist/chrome'
await build()
for (const entry of ['content']) {
    await build({
        configFile: false,
        publicDir: false,
        build: {
            outDir,
            emptyOutDir: false,
            sourcemap: false,
            lib: {
                entry: `src/labstart/${entry}.js`,
                name: 'labstart',
                formats: ['iife'],
                fileName: () => entry + '.js',
            },
        },
    })
}

const manifestPath = join(outDir, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const googleClient = process.env.LABSTART_GOOGLE_TASKS_CLIENT_ID
if (googleClient) {
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(googleClient)) {
        throw new Error('Invalid Google Tasks OAuth client ID')
    }
    manifest.oauth2 = { client_id: googleClient, scopes: ['https://www.googleapis.com/auth/tasks'] }
} else {
    delete manifest.optional_permissions
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + '\n')
await copyFile('node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2',
    join(outDir, 'icons/geist-mono.woff2'))
await copyFile('LICENSE', join(outDir, 'LICENSE'))
await copyFile('node_modules/@fontsource-variable/geist-mono/LICENSE', join(outDir, 'LICENSE-Geist.txt'))
await copyFile('node_modules/simple-icons-font/LICENSE.md', join(outDir, 'LICENSE-Simple-Icons.txt'))

const archive = {}
async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const name = prefix + entry.name
        if (entry.isDirectory()) await collect(path, name + '/')
        else archive[name] = new Uint8Array(await readFile(path))
    }
}
await collect(outDir)
const zipPath = `dist/labstart-chrome-v${manifest.version}.zip`
await writeFile(zipPath, zipSync(archive))
console.log(zipPath)
