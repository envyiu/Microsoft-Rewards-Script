import crypto from 'node:crypto'

import { deriveNetworkGroup } from '../../../packages/contracts/smartConfig.js'

// Account planner state travels with ordinary proxy-group handoff and survives midnight.
export const proxyCooldownMethods = {
    _proxyCooldownUntil(group, accountIndex, now = Date.now()) {
        let until = 0
        for (const [index, state] of Object.entries(this.document.state.accounts || {})) {
            const rest = state.proxyCooldown
            if (Number(index) === Number(accountIndex) || rest?.networkGroup !== group) continue
            until = Math.max(until, Date.parse(rest.until) || 0)
        }
        return until > now ? until : 0
    },

    _recordProxyCooldown(job) {
        const account = this._cachedAccounts().find(a => a.index === job.accountIndex)
        const state = this.document.state.accounts[String(job.accountIndex)]
        if (!account?.proxy || !state) return
        const endedAt = Date.now()
        state.proxyCooldown = {
            networkGroup: job.networkGroup || deriveNetworkGroup(account, this.document.config.networkGroupOverride),
            endedAt: new Date(endedAt).toISOString(),
            until: new Date(endedAt + crypto.randomInt(5, 21) * 60_000).toISOString()
        }
        this._save()
    }
}
