import type { MicrosoftRewardsBot } from '../../../index'
import type { ParsedOffer, StreakState } from '../../../browser/ReactFunc'
import type { DashboardData } from '../../../interface/DashboardData'

export type ActivationResult = 'activated' | 'already-active' | 'absent' | 'failed'

export interface ActivationMetadata {
    activityType: number
    activityTypeSource: 'react' | 'streak' | 'dashboard' | 'verified-fallback'
    isPromotional: boolean
}

export interface ActivationTarget extends ParsedOffer {
    activationSource: 'streak' | 'offer'
}

export interface StreakActivationConfig {
    logTag: string
    featureLabel: string
    streakTitle: string
    exactOfferId: string
    verifiedActivityTypes: ReadonlyMap<string, number>
    matchPartner: (partner: string) => boolean
    matchFuzzyOfferId: (lowerOfferId: string) => boolean
    waitAfterReport: (delayMs: number) => Promise<boolean>
}

export class StreakActivation {
    private readonly bot: MicrosoftRewardsBot
    private readonly config: StreakActivationConfig

    constructor(bot: MicrosoftRewardsBot, config: StreakActivationConfig) {
        this.bot = bot
        this.config = config
    }

    public findStreak(streaks?: StreakState[]): StreakState | undefined {
        if (streaks) return streaks.find(s => this.config.matchPartner(s.partner))

        const snapshots = [this.bot.reactSnapshot, this.bot.reactSnapshots.desktop, this.bot.reactSnapshots.mobile]
        for (const snapshot of snapshots) {
            const streak = snapshot?.streaks.find(s => this.config.matchPartner(s.partner))
            if (streak) return streak
        }
        return undefined
    }

    public async activate(data: DashboardData): Promise<ActivationResult> {
        const offer = this.findActivationTarget()
        if (!offer) {
            this.bot.logger.debug(
                this.bot.isMobile,
                this.config.logTag,
                `No ${this.config.featureLabel} activation metadata present in the streak model or generic offers across the current, desktop, or cached mobile Rewards snapshots`
            )
            return 'absent'
        }

        if (offer.isCompleted) {
            this.bot.logger.info(
                this.bot.isMobile,
                this.config.logTag,
                `${this.config.featureLabel} activation offer already completed | offerId=${offer.offerId}`,
                'green'
            )
            return 'already-active'
        }

        if (!offer.hash) {
            this.bot.logger.warn(
                this.bot.isMobile,
                this.config.logTag,
                `Activation offer present but missing a hash | offerId=${offer.offerId}`
            )
            return 'failed'
        }

        if (!offer.reportable && !offer.isLocked) {
            this.bot.logger.warn(
                this.bot.isMobile,
                this.config.logTag,
                `Activation offer is not actionable | offerId=${offer.offerId}`
            )
            return 'failed'
        }

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                this.config.logTag,
                'Skipping activation: "reportActivity" action id not discovered in bundle'
            )
            return 'failed'
        }

        const dashboard = await this.resolveDashboard(data)
        const metadata = this.resolveActivationMetadata(offer, dashboard)
        if (!metadata) {
            this.bot.logger.warn(
                this.bot.isMobile,
                this.config.logTag,
                `Skipping activation: no valid activity type found | offerId=${offer.offerId}`
            )
            return 'failed'
        }

        this.bot.logger.info(
            this.bot.isMobile,
            this.config.logTag,
            `Activating ${this.config.featureLabel} | offerId=${offer.offerId} | activationSource=${offer.activationSource} | activityType=${metadata.activityType} | activityTypeSource=${metadata.activityTypeSource} | promotional=${metadata.isPromotional} | geo=${this.bot.userData.geoLocale}`
        )

        try {
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [
                offer.hash,
                metadata.activityType,
                {
                    offerid: offer.offerId,
                    isPromotional: metadata.isPromotional ? 'true' : '$undefined',
                    timezoneOffset: this.bot.userData.timezoneOffset
                }
            ])

            const continued = await this.config.waitAfterReport(this.bot.utils.randomDelay(3000, 6000))
            if (!continued) return 'failed'
            const confirmed = await this.confirmActivation(offer.offerId)

            if (acknowledged || confirmed) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    this.config.logTag,
                    `Activated ${this.config.featureLabel} | offerId=${offer.offerId} | acknowledged=${acknowledged} | confirmed=${confirmed}`,
                    'green'
                )
                return 'activated'
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                this.config.logTag,
                `Activation not acknowledged | offerId=${offer.offerId} | status=${status}`
            )
            return 'failed'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                this.config.logTag,
                `Activation error | offerId=${offer.offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
            return 'failed'
        }
    }

    public findActivationTarget(): ActivationTarget | null {
        const snapshots = [
            { source: 'current', snapshot: this.bot.reactSnapshot },
            { source: 'desktop', snapshot: this.bot.reactSnapshots.desktop },
            { source: 'mobile', snapshot: this.bot.reactSnapshots.mobile }
        ] as const

        const seen = new Set<unknown>()

        for (const { source, snapshot } of snapshots) {
            if (!snapshot || seen.has(snapshot)) continue
            seen.add(snapshot)

            const streak = this.findStreak(snapshot.streaks)
            if (!streak?.activationOfferId || !streak.activationHash) continue

            if (source !== 'current') {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    this.config.logTag,
                    `Activation metadata missing from the current snapshot; using cached ${source} streak snapshot | offerId=${streak.activationOfferId}`
                )
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    this.config.logTag,
                    `Using ${this.config.featureLabel} activation metadata from streak model | offerId=${streak.activationOfferId}`
                )
            }

            return {
                offerId: streak.activationOfferId,
                hash: streak.activationHash,
                title: this.config.streakTitle,
                description: '',
                points: 0,
                promotionSubtype: null,
                destination: streak.destinationUrl ?? '',
                isCompleted: streak.isEnabled,
                isPromotional: false,
                isLocked: false,
                unlockCriteria: null,
                date: null,
                activityType: streak.activationActivityType,
                reportable: true,
                activationSource: 'streak'
            }
        }

        seen.clear()
        for (const { source, snapshot } of snapshots) {
            if (!snapshot || seen.has(snapshot)) continue
            seen.add(snapshot)

            const exact = snapshot.offers.find(o => o.offerId === this.config.exactOfferId)
            const fuzzy = snapshot.offers.find(o => this.config.matchFuzzyOfferId(o.offerId.toLowerCase()))
            const offer = exact ?? fuzzy
            if (!offer) continue

            if (source !== 'current') {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    this.config.logTag,
                    `Activation offer missing from the current snapshot; using cached ${source} offer snapshot | offerId=${offer.offerId}`
                )
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    this.config.logTag,
                    `Using ${this.config.featureLabel} activation metadata from generic offer | offerId=${offer.offerId}`
                )
            }

            return { ...offer, activationSource: 'offer' }
        }

        return null
    }

    public resolveActivationMetadata(offer: ActivationTarget, data: DashboardData): ActivationMetadata | null {
        const dashboardPromotion = findDashboardPromotion(data.dashboard, offer.offerId)

        if (offer.activityType !== null) {
            return {
                activityType: offer.activityType,
                activityTypeSource: offer.activationSource === 'streak' ? 'streak' : 'react',
                isPromotional: offer.isPromotional || dashboardPromotionIsPromotional(dashboardPromotion)
            }
        }

        const dashboardActivityType = dashboardPromotionActivityType(dashboardPromotion)
        if (dashboardActivityType !== null) {
            return {
                activityType: dashboardActivityType,
                activityTypeSource: 'dashboard',
                isPromotional: offer.isPromotional || dashboardPromotionIsPromotional(dashboardPromotion)
            }
        }

        const verifiedFallback = this.config.verifiedActivityTypes.get(offer.offerId.toLowerCase())
        if (verifiedFallback !== undefined) {
            return {
                activityType: verifiedFallback,
                activityTypeSource: 'verified-fallback',
                isPromotional: offer.isPromotional || dashboardPromotionIsPromotional(dashboardPromotion)
            }
        }

        return null
    }

    private async confirmActivation(offerId: string): Promise<boolean> {
        try {
            const snapshot = await this.bot.browser.func.refreshEarnSnapshot()
            if (!snapshot) return false

            this.bot.reactSnapshot = snapshot

            const streak = this.findStreak(snapshot.streaks)
            const activationOffer = snapshot.offers.find(o => o.offerId === offerId)
            return streak?.isEnabled === true || activationOffer?.isCompleted === true
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                this.config.logTag,
                `Could not verify activation state | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async resolveDashboard(fallback: DashboardData): Promise<DashboardData> {
        try {
            return await this.bot.browser.func.getDashboardData(this.bot.cookies.desktop)
        } catch {
            this.bot.logger.debug(
                this.bot.isMobile,
                this.config.logTag,
                'Desktop dashboard fetch failed - falling back to the dashboard from the mobile pass'
            )
            return fallback
        }
    }
}

export function findDashboardPromotion(root: unknown, offerId: string): Record<string, unknown> | null {
    const target = offerId.toLowerCase()
    const pending: unknown[] = [root]
    const visited = new Set<object>()

    while (pending.length) {
        const value = pending.pop()
        if (!value || typeof value !== 'object' || visited.has(value)) continue
        visited.add(value)

        if (Array.isArray(value)) {
            for (const entry of value) pending.push(entry)
            continue
        }

        const record = value as Record<string, unknown>
        const attributes = asRecord(record.attributes)
        const candidateId = record.offerId ?? record.offerid ?? attributes?.offerid
        if (typeof candidateId === 'string' && candidateId.toLowerCase() === target) return record

        for (const entry of Object.values(record)) pending.push(entry)
    }

    return null
}

export function dashboardPromotionActivityType(promotion: Record<string, unknown> | null): number | null {
    if (!promotion) return null
    const attributes = asRecord(promotion.attributes)
    return parseActivityType(
        promotion.activityType ?? promotion.activity_type ?? attributes?.activityType ?? attributes?.activity_type
    )
}

export function dashboardPromotionIsPromotional(promotion: Record<string, unknown> | null): boolean {
    if (!promotion) return false
    const attributes = asRecord(promotion.attributes)
    const value = promotion.isPromotional ?? promotion.promotional ?? attributes?.promotional
    return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function parseActivityType(value: unknown): number | null {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
