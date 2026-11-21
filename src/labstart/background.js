import {
    CONFIG_KEY, DOH_ORIGIN, MIN_INTERVAL, normalizeConfig, RIPE_ORIGIN, SECRETS_KEY, sourceOrigins, STATE_KEY, WEB_ORIGINS,
} from './data/config.js'
import { runSource } from './data/adapters.js'
import { DEMO_SITE, demoState } from './data/demo.js'
import {
    cachedAsn, fetchAsn, fetchPtr, navigationMatches, normalizeTiming, publicAddress, siteSnapshot,
} from './data/site.js'
import { EMPTY_STATE, makeState, queueAlert, sourceSnapshot, takeAlert } from './data/state.js'

const SOURCE_ALARM = 'labstart:source:'
const DEMO_ALARM = 'labstart:demo'
const ALERT_ALARM = 'labstart:notify'
const ALERT_KEY = 'labstartAlert'
const ASN_CACHE_KEY = 'labstartAsnCache'
const NOTIFY_COOLDOWN_MS = 10 * 60_000
const PTR_CACHE_KEY = 'labstartPtrCache'
const ASN_TTL = 3_600_000
const NEGATIVE_ASN_TTL = 300_000
const navigationKey = tabId => `labstartNavigation:${tabId}`

let scheduled = Promise.resolve()
let asnQueue = Promise.resolve()
let notificationTimer

const getSession = async key => (await chrome.storage.session.get(key))[key]
const getConfig = async () => normalizeConfig((await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY])

function run(work) {
    scheduled = scheduled.then(work).catch(() => {})
}

function pageConfig({ chipEnabled, disabledSites, demoMode, asnEnabled, rdnsEnabled }) {
    return { chipEnabled, disabledSites, demoMode, asnEnabled, rdnsEnabled }
}

function sendTab(tabId, message, documentId) {
    return chrome.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 }).catch(() => {})
}

async function publishAlertLine(state, config) {
    const tabs = await chrome.tabs.query({ url: WEB_ORIGINS })
    const message = { type: 'labstart:update', state: { severity: state.severity }, config: pageConfig(config) }
    await Promise.all(tabs.map(tab => sendTab(tab.id, message)))
}

async function flushAlert() {
    const current = await getSession(ALERT_KEY)
    const settled = takeAlert(current, Date.now())
    if (!settled) return
    // A source that flaps between states still produces at most one notification per state every few minutes.
    const now = Date.now()
    const notifiedAt = current?.notifiedAt ?? {}
    const quiet = notifiedAt[settled.last] > now - NOTIFY_COOLDOWN_MS
    await chrome.storage.session.set({
        [ALERT_KEY]: { ...settled, notifiedAt: quiet ? notifiedAt : { ...notifiedAt, [settled.last]: now } },
    })
    await chrome.alarms.clear(ALERT_ALARM)
    if (quiet || !(await getConfig()).notificationsEnabled) return
    const label = { ok: 'checks recovered', warn: 'check warning', crit: 'check failed' }[settled.last]
    const state = await getSession(STATE_KEY)
    const failed = Object.values(state?.sources ?? {}).filter(source => source.severity !== 'ok').map(source => source.label)
    const names = failed.slice(0, 3).join(', ')
    const message = names ? `${names}${failed.length > 3 ? ` +${failed.length - 3} more` : ''}` : 'All configured checks are healthy.'
    await chrome.notifications?.create('labstart-health', {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: `labstart · ${label}`, message,
    })
}

async function updateAlert(severity, enabled) {
    const previous = await getSession(ALERT_KEY)
    const queued = enabled ? queueAlert(previous, severity, Date.now()) : { last: severity, pending: null }
    const alert = { ...queued, notifiedAt: previous?.notifiedAt }
    if (previous?.last !== alert.last || previous?.pending !== alert.pending) {
        await chrome.storage.session.set({ [ALERT_KEY]: alert })
    }
    clearTimeout(notificationTimer)
    if (!alert.pending) {
        if (previous?.pending) await chrome.alarms.clear(ALERT_ALARM)
        return
    }
    if (!await chrome.alarms.get(ALERT_ALARM)) {
        await chrome.alarms.create(ALERT_ALARM, { delayInMinutes: MIN_INTERVAL / 60 })
    }
    notificationTimer = setTimeout(() => run(flushAlert), Math.max(0, alert.pending.dueAt - Date.now()))
}

async function syncAlarms(config) {
    const active = config.demoMode
        ? [[DEMO_ALARM, MIN_INTERVAL / 60]]
        : config.sources.filter(source => source.enabled).map(source => [SOURCE_ALARM + source.id, source.intervalSeconds / 60])
    const wanted = new Map(active)
    const alarms = await chrome.alarms.getAll()
    const existing = new Map(alarms.map(alarm => [alarm.name, alarm]))
    for (const alarm of alarms) {
        if ((alarm.name === DEMO_ALARM || alarm.name.startsWith(SOURCE_ALARM)) && !wanted.has(alarm.name)) {
            await chrome.alarms.clear(alarm.name)
        }
    }
    for (const [name, periodInMinutes] of active) {
        if (existing.get(name)?.periodInMinutes !== periodInMinutes) {
            await chrome.alarms.create(name, { periodInMinutes })
        }
    }
}

async function checkSource(source, secret) {
    const origins = sourceOrigins(source)
    if (origins.length && !await chrome.permissions.contains({ origins })) {
        throw new Error('Browser access is missing. Save or test the source in options to grant access.')
    }
    return runSource(source, secret)
}

async function collectSource(source, secret, previous) {
    let result
    try {
        result = await checkSource(source, secret)
    } catch (error) {
        result = { error: error.message || 'The source could not be checked.' }
    }
    return sourceSnapshot(source.label, result, previous, Date.now(), source.type === 'claude' ? 'warn' : 'crit')
}

async function updateState({ alarm, oldConfig, secretIds = [], startup = false, availabilityChanged = false } = {}) {
    const settings = await chrome.storage.local.get([CONFIG_KEY, SECRETS_KEY])
    const config = normalizeConfig(settings[CONFIG_KEY])
    const previous = await getSession(STATE_KEY) ?? EMPTY_STATE
    if (!alarm) await syncAlarms(config)

    let state
    if (config.demoMode) {
        state = demoState(Date.now(), config.demoOutage)
    } else {
        const previousSources = previous.demo ? {} : previous.sources
        const oldSources = new Map(oldConfig?.sources.map(source => [source.id, source]))
        const active = config.sources.filter(source => source.enabled)
        const results = await Promise.all(active.map(async source => {
            const prior = previousSources[source.id]
            const changed = oldConfig && JSON.stringify(oldSources.get(source.id)) !== JSON.stringify(source)
            const startupDue = startup && prior && Date.now() - prior.checkedAt >= source.intervalSeconds * 1000
            const due = !prior || changed || startupDue || availabilityChanged || alarm === SOURCE_ALARM + source.id
                || secretIds.includes(source.id)
            return [source.id, due ? await collectSource(source, settings[SECRETS_KEY]?.[source.id], changed ? null : prior) : prior]
        }))
        state = makeState(Object.fromEntries(results), Date.now())
        if (!previous.demo && results.length === Object.keys(previousSources).length
            && results.every(([id, result]) => previousSources[id] === result)) state = previous
    }

    if (state !== previous || !previous.updatedAt) await chrome.storage.session.set({ [STATE_KEY]: state })
    const changedPageConfig = oldConfig && JSON.stringify(pageConfig(oldConfig)) !== JSON.stringify(pageConfig(config))
    if (previous.severity !== state.severity || changedPageConfig || availabilityChanged) await publishAlertLine(state, config)
    await updateAlert(state.severity, config.notificationsEnabled)
}

function lookupAsn(ip) {
    // Queue lookups so adjacent addresses can reuse a newly discovered prefix.
    const queued = asnQueue.then(async () => {
        const config = await getConfig()
        if (!config.asnEnabled || config.demoMode || !await chrome.permissions.contains({ origins: [RIPE_ORIGIN] })) return null
        const now = Date.now()
        const saved = await getSession(ASN_CACHE_KEY) ?? {}
        const cache = Object.fromEntries(Object.entries(saved).filter(([, record]) => record.expires > now).slice(-255))
        const existing = cachedAsn(cache, ip, now)
        if (existing) return existing
        let record
        try {
            record = await fetchAsn(ip)
        } catch {
            record = { prefix: ip, asn: null, org: null, cdn: null }
        }
        cache[record.prefix] = { ...record, expires: now + (record.asn ? ASN_TTL : NEGATIVE_ASN_TTL) }
        await chrome.storage.session.set({ [ASN_CACHE_KEY]: cache })
        return record
    })
    asnQueue = queued.catch(() => {})
    return queued
}

// Reverse DNS runs only when someone opens the details box, never in the background.
async function lookupPtr(ip, hostname) {
    const config = await getConfig()
    if (config.demoMode) return 'edge-24.example.com'
    if (!config.rdnsEnabled || config.disabledSites.includes(hostname) || !publicAddress(ip)
        || !await chrome.permissions.contains({ origins: [DOH_ORIGIN] })) return null
    const now = Date.now()
    const saved = await getSession(PTR_CACHE_KEY) ?? {}
    if (saved[ip]?.expires > now) return saved[ip].name
    let name = null
    try {
        name = await fetchPtr(ip)
    } catch {}
    const cache = Object.fromEntries(Object.entries(saved).filter(([, record]) => record.expires > now).slice(-255))
    cache[ip] = { name, expires: now + (name ? ASN_TTL : NEGATIVE_ASN_TTL) }
    await chrome.storage.session.set({ [PTR_CACHE_KEY]: cache })
    return name
}

async function siteResponse(message, sender) {
    const tabId = sender.tab?.id
    const state = await getSession(STATE_KEY) ?? EMPTY_STATE
    const config = await getConfig()
    const timing = normalizeTiming(message.timing)
    const navigation = tabId !== undefined ? await getSession(navigationKey(tabId)) : null
    const ip = navigationMatches(navigation, sender, timing) ? navigation.ip : null
    let site = config.demoMode ? DEMO_SITE : siteSnapshot(ip, timing)
    const hostname = sender.url ? new URL(sender.url).hostname : ''
    if (!config.demoMode && config.chipEnabled && config.asnEnabled && !config.disabledSites.includes(hostname) && publicAddress(ip)) {
        const existing = cachedAsn(await getSession(ASN_CACHE_KEY) ?? {}, ip, Date.now())
        if (existing) {
            site = siteSnapshot(ip, timing, existing)
        } else {
            void lookupAsn(ip).then(async result => {
                if (!result?.asn) return
                const current = await getConfig()
                if (!current.asnEnabled || current.demoMode || !current.chipEnabled || current.disabledSites.includes(hostname)) return
                await sendTab(tabId, { type: 'labstart:site-update', site: siteSnapshot(ip, timing, result) }, sender.documentId)
            }).catch(() => {})
        }
    }
    return { state: { severity: state.severity }, config: pageConfig(config), site }
}

async function rememberNavigation({ tabId, documentId, url, ip, timeStamp }) {
    if (tabId < 0 || (await getConfig()).demoMode) return
    const key = navigationKey(tabId)
    const previous = await getSession(key)
    if (previous?.timeStamp > timeStamp) return
    await chrome.storage.session.set({ [key]: { documentId: documentId ?? null, url, ip: ip ?? null, timeStamp } })
    await sendTab(tabId, { type: 'labstart:site-refresh' })
}

chrome.runtime.onInstalled.addListener(() => {
    void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    run(() => updateState({ startup: true }))
})
chrome.runtime.onStartup.addListener(() => run(() => updateState({ startup: true })))

chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === ALERT_ALARM) run(flushAlert)
    if (name === DEMO_ALARM || name.startsWith(SOURCE_ALARM)) run(() => updateState({ alarm: name }))
})

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[CONFIG_KEY] && !changes[SECRETS_KEY])) return
    const oldConfig = changes[CONFIG_KEY] && normalizeConfig(changes[CONFIG_KEY].oldValue)
    const secrets = changes[SECRETS_KEY]
    const ids = new Set([...Object.keys(secrets?.oldValue ?? {}), ...Object.keys(secrets?.newValue ?? {})])
    const secretIds = [...ids].filter(id => JSON.stringify(secrets.oldValue?.[id]) !== JSON.stringify(secrets.newValue?.[id]))
    run(() => updateState({ oldConfig, secretIds }))
})

function hostPermissionsChanged({ origins }) {
    if (origins?.length) run(() => updateState({ availabilityChanged: true }))
}
chrome.permissions.onAdded.addListener(hostPermissionsChanged)
chrome.permissions.onRemoved.addListener(hostPermissionsChanged)

chrome.commands.onCommand.addListener(command => {
    if (command !== 'toggle-chip') return
    run(async () => {
        const config = await getConfig()
        await chrome.storage.local.set({ [CONFIG_KEY]: { ...config, chipEnabled: !config.chipEnabled } })
    })
})

chrome.webRequest.onCompleted.addListener(details => {
    void rememberNavigation(details).catch(() => {})
}, { urls: WEB_ORIGINS, types: ['main_frame'] })

chrome.tabs.onRemoved.addListener(tabId => {
    void chrome.storage.session.remove(navigationKey(tabId)).catch(() => {})
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false
    if (message?.type === 'labstart:site' && sender.frameId === 0 && sender.tab && /^https?:/.test(sender.url ?? '')) {
        void siteResponse(message, sender).then(sendResponse, () => sendResponse(null))
        return true
    }
    if (message?.type === 'labstart:rdns' && sender.frameId === 0 && sender.tab && /^https?:/.test(sender.url ?? '')) {
        const ip = typeof message.ip === 'string' ? message.ip.slice(0, 64) : ''
        void lookupPtr(ip, new URL(sender.url).hostname).then(sendResponse, () => sendResponse(null))
        return true
    }
    if (message?.type === 'labstart:test-source' && sender.url?.startsWith(chrome.runtime.getURL(''))) {
        void checkSource(message.source, message.secret).then(
            result => sendResponse({ ok: true, ...result }),
            error => sendResponse({ ok: false, error: error.message || 'The source could not be checked.' }),
        )
        return true
    }
    return false
})
