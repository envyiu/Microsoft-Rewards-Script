import type { Page } from 'patchright'
import { URLs } from '../../constants/urls'
import type { MicrosoftRewardsBot } from '../../index'
import { emitRuntimeEvent } from '../../util/RuntimeEvents'
import { classifyRewardsPage, type RewardsPageState } from '../RewardsState'

export class RscBootstrapClient {
    public rewardsDeploymentId = ''
    private bootstrapRecoveryInProgress = false

    constructor(private readonly bot: MicrosoftRewardsBot) {}

    public async bootstrap(page: Page): Promise<void> {
        const deadline = Date.now() + 45_000
        const delays = [0, 1000, 3000]
        let lastState: RewardsPageState = 'loading'
        let lastError: unknown

        for (let attempt = 0; attempt < delays.length && Date.now() < deadline; attempt++) {
            if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]))
            try {
                const navigationTimeout = Math.max(250, Math.min(15_000, deadline - Date.now()))
                if (attempt === 0) {
                    await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: navigationTimeout })
                } else {
                    await page
                        .reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeout })
                        .catch(() => undefined)
                }
                await this.dismissRewardsWelcomeDialog(page, deadline)

                const earnDom = await page.content()
                const earnRaw = await this.fetchBootstrapHtml(page, URLs.rewards.earn, '/earn', deadline)
                const dashboardHtml = await this.fetchBootstrapHtml(
                    page,
                    URLs.rewards.dashboard,
                    '/dashboard',
                    deadline
                )
                const sources = [earnRaw, earnDom, dashboardHtml].filter(Boolean)
                const combined = sources.join('\n')
                const snapshot = this.bot.browser.react.snapshotPage(sources)
                if (snapshot.streakObservation) {
                    emitRuntimeEvent('streakSnapshot', { ...snapshot.streakObservation })
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'REWARDS-STREAK',
                        JSON.stringify(snapshot.streakObservation)
                    )
                }
                const actions = await this.resolveActionIds(page, sources, deadline)

                lastState = classifyRewardsPage({
                    url: page.url(),
                    html: combined,
                    snapshot,
                    actionCount: Object.keys(actions).length,
                    rewardsAccountConfirmed: /["']isRewardsUser["']\s*:\s*true/i.test(combined)
                })

                if (lastState === 'rewards-ready' || lastState === 'rewards-partial') {
                    this.rewardsDeploymentId = this.bot.browser.react.buildId(earnRaw || earnDom) ?? ''
                    this.bot.nextRouterStateTree = this.bot.browser.react.routerStateTree('earn')
                    this.bot.reactSnapshot = snapshot
                    if (this.bot.isMobile) this.bot.reactSnapshots.mobile = snapshot
                    else this.bot.reactSnapshots.desktop = snapshot
                    this.bot.nextActions = actions

                    if (!snapshot.offers.length) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'BOOTSTRAP',
                            'Rewards account confirmed with no offers; offer-dependent tasks will be skipped'
                        )
                    }
                    if (!Object.keys(actions).length) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'BOOTSTRAP',
                            'Rewards data is partial; server-action-dependent tasks will be deferred'
                        )
                    }
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Context ready | state=${lastState} | actions=${Object.keys(actions).length} | reportable=${snapshot.reportable.length} | available=${snapshot.account.availablePoints}`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'BUILD',
                        `Rewards build | id=${this.rewardsDeploymentId || 'unknown'}`,
                        'cyan'
                    )
                    return
                }
            } catch (error) {
                lastError = error
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Context attempt ${attempt + 1}/3 incomplete | state=${lastState} | error=${lastError ? this.errorMessage(lastError) : 'none'}`
            )
        }

        if (!this.bootstrapRecoveryInProgress) {
            this.bootstrapRecoveryInProgress = true
            try {
                if (await this.bot.refreshCurrentRewardsContext(`bootstrap-${lastState}`)) return
            } finally {
                this.bootstrapRecoveryInProgress = false
            }
        }

        const message = `Rewards context unavailable after recovery | state=${lastState} | error=${lastError ? this.errorMessage(lastError) : 'none'}`
        this.bot.logger.error(this.bot.isMobile, 'BOOTSTRAP', message)
        throw new Error(message)
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }

    public async dismissRewardsWelcomeDialog(page: Page, deadline = Date.now() + 10_000): Promise<void> {
        try {
            const welcomeDialog =
                typeof page.getByRole === 'function'
                    ? page
                          .getByRole('dialog')
                          .filter({ hasText: /welcome to\s+microsoft rewards/i })
                          .first()
                    : null
            if (welcomeDialog && (await welcomeDialog.isVisible().catch(() => false))) {
                const getStarted = welcomeDialog.getByRole('button', { name: /^get started$/i }).first()
                if (await getStarted.isVisible().catch(() => false)) {
                    await getStarted.click({ timeout: Math.max(250, Math.min(5000, deadline - Date.now())) })
                    this.bot.logger.info(this.bot.isMobile, 'BOOTSTRAP', 'Dismissed welcome dialog with Get started')
                    return
                }
            }
            const welcomeButton = await page
                .waitForSelector('section[role="dialog"] button[slot="close"]', {
                    timeout: Math.max(250, Math.min(5000, deadline - Date.now()))
                })
                .catch(() => null)
            if (!welcomeButton) return

            await welcomeButton.click({ timeout: Math.max(250, Math.min(5000, deadline - Date.now())) })
            this.bot.logger.info(this.bot.isMobile, 'BOOTSTRAP', 'Dismissed welcome dialog')

            await page
                .waitForLoadState('domcontentloaded', {
                    timeout: Math.max(250, Math.min(5000, deadline - Date.now()))
                })
                .catch(() => undefined)
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed to dismiss welcome dialog: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async fetchBootstrapHtml(
        page: Page,
        url: string,
        route: string,
        deadline = Date.now() + 20_000
    ): Promise<string> {
        try {
            const res = await page.request.get(url, { timeout: Math.max(250, Math.min(20_000, deadline - Date.now())) })
            if (res.ok()) return await res.text()

            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed to fetch ${route} HTML | status=${res.status()} - snapshot and action discovery may be incomplete`
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed to fetch ${route} HTML | error=${error instanceof Error ? error.message : String(error)} - snapshot and action discovery may be incomplete`
            )
        }

        return ''
    }

    private async resolveActionIds(
        page: Page,
        htmls: string[],
        deadline = Date.now() + 20_000
    ): Promise<Record<string, string>> {
        const result: Record<string, string> = {}

        try {
            const initialChunks = new Set<string>()
            const chunkRegex = /(?:\/_next\/)?(static\/(?:chunks|immutable|media)\/[\w\-./()]+?\.js)/g
            for (const html of htmls) {
                if (!html) continue
                for (const match of html.matchAll(chunkRegex)) {
                    initialChunks.add('/_next/' + match[1]!)
                }
            }

            if (initialChunks.size === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    'No initial chunks discovered in HTML - chunk reference shape may have changed'
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `Fetching ${initialChunks.size} initial JS chunks`)
            const jsByPath = await this.fetchJsChunks(page, [...initialChunks], deadline)

            const dynamicPaths = new Set<string>()
            for (const js of jsByPath.values()) {
                for (const path of extractDynamicChunkPaths(js)) {
                    if (!jsByPath.has(path)) dynamicPaths.add(path)
                }
            }

            if (dynamicPaths.size) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    `Fetching ${dynamicPaths.size} dynamic chunks discovered via webpack manifest`
                )
                const moreJs = await this.fetchJsChunks(page, [...dynamicPaths], deadline)
                for (const [path, js] of moreJs) jsByPath.set(path, js)
            }

            for (const [path, js] of jsByPath) {
                const filename = path.split('/').pop() ?? path
                const ids = this.bot.browser.react.extractActionIds(js)
                const names = Object.keys(ids.byName)

                if (names.length) {
                    Object.assign(result, ids.byName)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${names.length} action id(s) in ${filename}: [${names.join(', ')}]`
                    )
                } else {
                    this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `No server-action ids found in ${filename}`)
                }

                const namedSet = new Set(Object.values(ids.byName))
                const unnamed = ids.all.filter(id => !namedSet.has(id))
                if (unnamed.length) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${unnamed.length} unnamed action id(s) in ${filename}: [${unnamed.join(', ')}]`
                    )
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Discovered ${Object.keys(result).length} action ids: [${Object.keys(result).join(', ')}]`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed resolving action ids | error=${error instanceof Error ? error.message : String(error)}`
            )
        }

        return result
    }

    private async fetchJsChunks(page: Page, paths: string[], deadline: number): Promise<Map<string, string>> {
        const result = new Map<string, string>()

        await Promise.all(
            paths.map(async path => {
                try {
                    const res = await page.request.get(URLs.rewards.path(path), {
                        timeout: Math.max(250, Math.min(10_000, deadline - Date.now()))
                    })
                    if (res.ok()) {
                        result.set(path, await res.text())
                    }
                } catch (error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Chunk fetch failed | path=${path} | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            })
        )

        return result
    }
}

export function extractDynamicChunkPaths(js: string): string[] {
    const seen = new Set<string>()

    const builder = /static\/chunks\/"\s*\+\s*\w+\s*\+\s*"([-.])"\s*\+\s*\{([\s\S]*?)\}\s*\[/g
    for (const match of js.matchAll(builder)) {
        const sep = match[1]!
        for (const [, id, hash] of match[2]!.matchAll(/(\d+)\s*:\s*"([a-f0-9]+)"/g)) {
            seen.add(`/_next/static/chunks/${id}${sep}${hash}.js`)
        }
    }

    for (const [, id, hash] of js.matchAll(/\b(\d{2,6}):"([a-f0-9]{12,})"/g)) {
        seen.add(`/_next/static/chunks/${id}-${hash}.js`)
        seen.add(`/_next/static/chunks/${id}.${hash}.js`)
    }

    const turbopackRegex = /"(static\/(?:immutable|chunks|media)\/[\w\-./()]+?\.js)"/g
    for (const match of js.matchAll(turbopackRegex)) {
        seen.add(`/_next/${match[1]}`)
    }

    return [...seen]
}
