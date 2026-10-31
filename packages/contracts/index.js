import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ConfigSchema, defaultConfig } = require('./dist/contracts/BotConfig.js')
export { ConfigSchema, defaultConfig }
export * from './protocol.js'
export * from './smartConfig.js'
export * from './accounts.js'
export * from './accountStore.js'
export * from './store.js'
export * from './newAccount.js'

export function validateBotConfig(config) {
    const result = ConfigSchema.safeParse(config)
    if (!result.success) throw Object.assign(new Error('Invalid bot configuration'), {
        code: 'BAD_REQUEST', status: 400,
        errors: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    })
    return result.data
}
