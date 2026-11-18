import { waitForActivity } from '../../../util/ActivityTiming'
import { BaseActivity } from '../BaseActivity'
import { StreakActivation, type ActivationResult } from '../shared/StreakActivation'

import type { StreakState } from '../../../browser/ReactFunc'
import type { DashboardData } from '../../../interface/DashboardData'
import { VisualSearchBrowser } from './VisualSearchBrowser'

const VISUAL_SEARCH_ACTIVATION_OFFER = 'visualsearch_streak_activation_v2'

const VERIFIED_ACTIVITY_TYPES = new Map<string, number>([
    ['ww_visualsearch_summerjuly26_activation_banner', 11],
    ['visualsearch_streak_activation_v2', 714]
])

const MAX_ATTEMPTS = 4
const MAX_ACQUISITION_FAILURES_PER_ATTEMPT = 3
const REGISTRATION_CHECKS = 3

export class VisualSearch extends BaseActivity {
    private readonly browserFlow = new VisualSearchBrowser(this.bot)
    private readonly streakActivation = new StreakActivation(this.bot, {
        logTag: 'VISUAL-SEARCH',
        featureLabel: 'visual search',
        streakTitle: 'Visual Search Streak',
        exactOfferId: VISUAL_SEARCH_ACTIVATION_OFFER,
        verifiedActivityTypes: VERIFIED_ACTIVITY_TYPES,
        matchPartner: partner => /visual.?search/i.test(partner),
        matchFuzzyOfferId: id => id.includes('visualsearch') && id.includes('activation'),
        waitAfterReport: async delayMs => {
            await waitForActivity(this.bot, delayMs)
            return true
        }
    })

    public async doVisualSearch(data: DashboardData): Promise<number> {
        if (this.bot.isMobile) {
            this.bot.logger.debug(this.bot.isMobile, 'VISUAL-SEARCH', 'Skipping on mobile - desktop-only activity')
            return 0
        }

        const streak = this.findStreak()
        this.logStreakState(streak)

        if (streak?.isCurrentDayCompleted) {
            this.bot.logger.info(
                this.bot.isMobile,
                'VISUAL-SEARCH',
                `Already completed today | visualSearchStreak=${streak.completedDays}/${streak.totalDays}`,
                'green'
            )
            return 0
        }

        const activation = await this.activate(data)

        const available = streak?.isEnabled === true || activation === 'activated' || activation === 'already-active'
        if (!available) {
            if (activation === 'failed') this.bot.logger.markWorkerFailure()
            this.bot.logger.info(
                this.bot.isMobile,
                'VISUAL-SEARCH',
                'Visual search not available for this account, skipping'
            )
            return 0
        }

        return await this.performDailySearch()
    }

    private findStreak(streaks?: StreakState[]): StreakState | undefined {
        return this.streakActivation.findStreak(streaks)
    }

    private logStreakState(streak: StreakState | undefined): void {
        if (!streak) {
            this.bot.logger.info(
                this.bot.isMobile,
                'VISUAL-SEARCH',
                'No visual-search streak in the snapshot - falling back to the activation offer'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'VISUAL-SEARCH',
            `Streak state | partner="${streak.partner}" | enabled=${streak.isEnabled} | dayCompleted=${streak.isCurrentDayCompleted} | days=${streak.completedDays}/${streak.totalDays} | currentDay=${streak.currentDay} | activities=${streak.activitiesCompleted}/${streak.activitiesTotal}`
        )

        if (!streak.isEnabled) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH',
                'Streak is present but not enabled - searches will not register until it is switched on'
            )
        }
    }

    private async activate(data: DashboardData): Promise<ActivationResult> {
        return await this.streakActivation.activate(data)
    }

    private async performDailySearch(): Promise<number> {
        const seenBcids = new Set<string>()
        const candidateSeeds = await this.browserFlow.getSeedUrls()

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const visual = await this.acquireFreshVisualSearch(seenBcids, candidateSeeds, attempt)
            if (!visual) {
                await waitForActivity(this.bot, this.bot.utils.randomDelay(3000, 6000))
                continue
            }

            const res = await this.browserFlow.report(visual)

            if (res.balance != null) this.bot.userData.currentPoints = res.balance

            const gained = res.gained ?? 0
            if (gained >= 5) {
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                this.bot.logger.info(
                    this.bot.isMobile,
                    'VISUAL-SEARCH',
                    `Daily visual search done | pointsGained=${gained} | currentBalance=${res.balance} | query="${visual.query}"`,
                    'green'
                )
                return gained
            }

            if (await this.waitForDayRegistration()) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'VISUAL-SEARCH',
                    `Daily visual search registered | pointsGained=0 (streak pays out on milestones) | query="${visual.query}"`,
                    'green'
                )
                return 0
            }

            if (res.acknowledged) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH',
                    `Visual search was reported but not credited (attempt ${attempt}/${MAX_ATTEMPTS}) | query="${visual.query}"`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH',
                    `No reportActivity acknowledgement (attempt ${attempt}/${MAX_ATTEMPTS}) | query="${visual.query}"`
                )
            }

            await waitForActivity(this.bot, this.bot.utils.randomDelay(3000, 6000))
        }

        this.bot.logger.markWorkerFailure()
        this.bot.logger.warn(
            this.bot.isMobile,
            'VISUAL-SEARCH',
            `Daily visual search did not credit after ${MAX_ATTEMPTS} attempts`
        )
        return 0
    }

    // bcid is derived from the image bytes, so a repeated seed produces a blob bing already credited
    private async acquireFreshVisualSearch(
        seen: Set<string>,
        candidateSeeds: string[],
        attempt: number
    ): Promise<{ bcid: string; query: string; serpUrl: string } | null> {
        let acquisitionFailures = 0

        while (candidateSeeds.length) {
            const seed = candidateSeeds.shift()
            if (!seed) continue

            const visual = await this.browserFlow.acquire(seed)
            if (!visual) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH',
                    `Could not obtain a visual search from one candidate (attempt ${attempt}/${MAX_ATTEMPTS})`
                )
                acquisitionFailures++
                if (acquisitionFailures >= MAX_ACQUISITION_FAILURES_PER_ATTEMPT) return null
                continue
            }

            if (!seen.has(visual.bcid)) {
                seen.add(visual.bcid)
                return visual
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH',
                `Skipping already-tried bcid=${visual.bcid.slice(0, 14)} | candidatesRemaining=${candidateSeeds.length}`
            )
            await waitForActivity(this.bot, this.bot.utils.randomDelay(1000, 2000))
        }

        this.bot.logger.warn(
            this.bot.isMobile,
            'VISUAL-SEARCH',
            `No unused visual-search seed remains (attempt ${attempt}/${MAX_ATTEMPTS})`
        )
        return null
    }

    private async waitForDayRegistration(): Promise<boolean> {
        for (let check = 1; check <= REGISTRATION_CHECKS; check++) {
            if (check > 1) {
                await waitForActivity(this.bot, this.bot.utils.randomDelay(2000, 4000))
            }
            if (await this.dayRegistered()) return true
        }

        return false
    }

    private async dayRegistered(): Promise<boolean> {
        const snapshot = await this.bot.browser.func.refreshEarnSnapshot()
        if (!snapshot) return false

        const streak = this.findStreak(snapshot.streaks)
        if (!streak) return false
        if (streak.isCurrentDayCompleted) return true

        this.bot.logger.debug(
            this.bot.isMobile,
            'VISUAL-SEARCH',
            `Streak still open after reporting | days=${streak.completedDays}/${streak.totalDays} | activities=${streak.activitiesCompleted}/${streak.activitiesTotal}`
        )
        return false
    }
}
