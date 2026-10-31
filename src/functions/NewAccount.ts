import type { BrowserContext, Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { Account } from '../interface/Account'
import { Login } from '../browser/auth/Login'
import { Search } from './activities/search/BrowserSearch'
import { SearchQueryQueue } from './SearchQueryQueue'
import { saveStorageState } from '../util/SessionStore'
import { installPreRewardsGuard } from '../../common/preRewardsGuard.cjs'
import { runBasicServiceAction } from './NewAccountServices'
import { errorDiagnostic } from '../util/ErrorDiagnostic'

const SERVICES: Record<string, { url: string; hosts: string[] }> = {
    onedrive: { url: 'https://onedrive.live.com/about/auth', hosts: ['onedrive.live.com'] },
    todo: { url: 'https://to-do.live.com/tasks/?app', hosts: ['to-do.live.com', 'to-do.microsoft.com', 'todo.microsoft.com', 'todo.cloud.microsoft', 'to-do.office.com'] },
    outlook: { url: 'https://outlook.live.com/mail/', hosts: ['outlook.live.com'] },
    calendar: { url: 'https://outlook.live.com/calendar/', hosts: ['outlook.live.com'] }
}

// No dashboard, Rewards API, point tracker or application OAuth participates.
export async function runNewAccountSession(bot: MicrosoftRewardsBot, account: Account, context: BrowserContext, page: Page): Promise<void> {
    const plan = bot.executionPlan
    if (plan?.type !== 'warmup') throw new Error('New account session requires an explicit execution plan')
    await installPreRewardsGuard(context)
    const login = new Login(bot)
    await login.login(page, account, { rewards: false })
    const search = new Search(bot)
    const queue = new SearchQueryQueue(bot)
    await queue.prepare()
    const services: string[] = []
    const serviceActions: string[] = []
    const artifacts = new Set(plan.artifacts || [])
    const checkpoint = async (queries: number) => {
        saveStorageState(bot.config.sessionPath, account.email, bot.isMobile, await context.storageState())
        bot.logger.info(bot.isMobile, 'NEW-ACCOUNT-CHECKPOINT', JSON.stringify({ jobId: plan.jobId, queries, services, serviceActions, artifacts: [...artifacts], at: new Date().toISOString() }))
    }
    for (const service of plan.services) {
        let stage = 'visit'
        const target = SERVICES[service]
        if (!target) throw new Error('Unknown Microsoft service')
        try {
            await login.login(page, account, { rewards: false, startUrl: target.url })
            for (let step = 0; step < 3; step++) {
                if (!target.hosts.includes(new URL(page.url()).hostname)) break
                const dialog = page.getByRole('dialog').first()
                if (!await dialog.isVisible().catch(() => false)) break
                const text = await dialog.innerText()
                if (!/welcome|terms of (?:use|service)|privacy notice|getting started/i.test(text)) break
                const button = dialog.getByRole('button', { name: /^(?:get started|continue|next|accept|i agree|okay|got it)$/i }).first()
                if (!await button.isVisible().catch(() => false)) break
                await button.click({ timeout: 5000 })
                await page.waitForTimeout(1000)
            }
            if (!target.hosts.includes(new URL(page.url()).hostname)) throw new Error('Service sign-in requires attention')
            await page.locator('body').waitFor({ state: 'visible', timeout: 15000 })
            const text = await page.locator('body').innerText({ timeout: 5000 })
            const signIn = page.getByRole('button', { name: /^sign in$/i }).or(page.getByRole('link', { name: /^sign in$/i })).first()
            if (await signIn.isVisible().catch(() => false)) throw new Error('Service requires interactive sign-in')
            if (!text.trim() || /something went wrong|access denied|verify your identity|account.*locked|buy.*subscription/i.test(text)) throw new Error('Service is not ready')
            services.push(service)
            await checkpoint(0)
            stage = 'action'
            const result = await runBasicServiceAction(page, service, artifacts.has(service))
            if (result.artifact) artifacts.add(service)
            serviceActions.push(service)
            await checkpoint(0)
            bot.logger.info(bot.isMobile, 'NEW-ACCOUNT-SERVICE-ACTION', `service=${service} | status=verified | ${result.detail}`)
        } catch (error) {
            bot.logger.warn(bot.isMobile, 'NEW-ACCOUNT-SERVICE-PENDING', `service=${service} | stage=${stage}`)
            if (bot.config.errorDiagnostics && error instanceof Error) await errorDiagnostic(page, error)
        }
    }
    await page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    const rejectCookies = page.locator('#bnp_btn_reject').first()
    if (await rejectCookies.isVisible().catch(() => false)) await rejectCookies.click({ timeout: 5000 })
    for (let queries = 1; queries <= plan.searchBudget; queries++) {
        if (bot.shuttingDown) throw new Error('New account session interrupted')
        const query = await queue.next()
        if (!query) throw new Error('Search query queue exhausted')
        await search.doUncountedQuery(page, query, bot.isMobile)
        await checkpoint(queries)
    }
}
