import { BOT_CONFIG_METADATA } from '../../../packages/contracts/configMetadata.js'
import {
    deepMerge,
    diffConfig,
    readConfig,
    syncMissingDefaults,
    validateConfig,
    writeConfigAtomic
} from '../configEditor.js'
import { envStr, redactSecrets } from '../lib.js'
import { readSchedule, writeSchedule } from '../scheduleStore.js'

export async function handleConfigAndLegacyScheduleRoutes(ctx) {
    const {
        req,
        res,
        url,
        method,
        pathname,
        sendJson,
        readJsonBody,
        projectRoot,
        loadConfigSafe,
        revealEnabled,
        tokenSet,
        allowConfigWrite,
        allowScheduleWrite,
        smartScheduler,
        pm
    } = ctx

    if (method === 'GET' && pathname === '/config') {
        const loaded = loadConfigSafe(projectRoot)
        if (!loaded) {
            sendJson(res, 404, { error: 'config.json not found' })
            return true
        }
        if (loaded.data == null) {
            sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })
            return true
        }
        const reveal = revealEnabled && Boolean(tokenSet) && url.searchParams.get('reveal') === '1'
        const data = reveal ? loaded.data : redactSecrets(loaded.data)
        sendJson(res, 200, { path: loaded.path, redacted: !reveal, config: data, schema: BOT_CONFIG_METADATA })
        return true
    }

    if (method === 'GET' && pathname === '/config/diff') {
        try {
            const { addedKeys } = await diffConfig(projectRoot, {
                validatorModule: envStr('API_VALIDATOR_MODULE')
            })
            sendJson(res, 200, { addedKeys, upToDate: addedKeys.length === 0 })
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
        return true
    }

    if (method === 'POST' && pathname === '/config/sync') {
        if (!allowConfigWrite) {
            sendJson(res, 403, {
                error: 'Config writes are disabled. Set API_ALLOW_CONFIG_WRITE=true to enable.'
            })
            return true
        }
        try {
            const result = await syncMissingDefaults(projectRoot, {
                validatorModule: envStr('API_VALIDATOR_MODULE')
            })
            if (result.patched) {
                pm.note(
                    'info',
                    `config.json patched with ${result.addedKeys.length} missing key(s) via API /config/sync.`
                )
            }
            sendJson(res, 200, { ...result, appliesOnNextRun: true })
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
        return true
    }

    if ((method === 'PUT' || method === 'PATCH') && pathname === '/config') {
        if (!allowConfigWrite) {
            sendJson(res, 403, {
                error: 'Config writes are disabled. Set API_ALLOW_CONFIG_WRITE=true to enable.'
            })
            return true
        }
        const body = await readJsonBody(req)
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            sendJson(res, 400, { error: 'Body must be a JSON object.' })
            return true
        }
        let candidate
        try {
            candidate = method === 'PATCH' ? deepMerge(readConfig(projectRoot).data, body) : body
        } catch (err) {
            sendJson(res, err.code === 'BAD_REQUEST' ? 400 : 500, {
                error: `Could not prepare config update: ${err instanceof Error ? err.message : err}`
            })
            return true
        }
        const result = await validateConfig(candidate, {
            projectRoot,
            validatorModule: envStr('API_VALIDATOR_MODULE')
        })
        if (!result.ok) {
            sendJson(res, 422, { error: 'Config validation failed', via: result.via, errors: result.errors })
            return true
        }
        try {
            const written = writeConfigAtomic(projectRoot, result.value ?? candidate)
            pm.note('info', `config.json updated via API (${method}); applies on the next run.`)
            sendJson(res, 200, { ok: true, path: written, via: result.via, appliesOnNextRun: true })
        } catch (err) {
            sendJson(res, 500, {
                error: `Could not write config: ${err instanceof Error ? err.message : err}`
            })
        }
        return true
    }

    if (method === 'GET' && pathname === '/schedule') {
        try {
            sendJson(res, 200, { ...readSchedule(projectRoot), writable: allowScheduleWrite })
        } catch (err) {
            sendJson(res, 500, { error: err.message, code: err.code })
        }
        return true
    }

    if ((method === 'PUT' || method === 'PATCH') && pathname === '/schedule') {
        if (!allowScheduleWrite) {
            sendJson(res, 403, {
                error: 'Schedule writes are disabled. Set API_ALLOW_SCHEDULE_WRITE=true to enable.'
            })
            return true
        }
        const body = await readJsonBody(req)
        if (body?.enabled && smartScheduler.get().effectiveEnabled) {
            sendJson(res, 409, {
                error: 'Disable Smart Scheduler before enabling cron.',
                code: 'SMART_SCHEDULE_ACTIVE'
            })
            return true
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            sendJson(res, 400, { error: 'Body must be a JSON object.' })
            return true
        }
        try {
            const updated = writeSchedule(projectRoot, body)
            pm.note(
                'info',
                `Schedule updated via API (${method}): ${updated.enabled ? `${updated.cron} (TZ ${updated.timezone})` : 'disabled'}.`
            )
            sendJson(res, 200, { ...updated, writable: true })
        } catch (err) {
            const status = err.code === 'BAD_REQUEST' ? 400 : 500
            sendJson(res, status, { error: err.message, code: err.code })
        }
        return true
    }

    return false
}
