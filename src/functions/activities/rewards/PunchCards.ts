import { creditedPoints, pointDelta } from '../../../util/PointAccounting'
import { readPunchCardParents, readPunchCardPage } from '../../../browser/parsers/PunchCardPageParser'
import { waitForActivity } from '../../../util/ActivityTiming'
import { URLs } from '../../../constants/urls'
import { BaseActivity } from '../BaseActivity'
import type { ParentQuest, QuestChild } from '../../../browser/ReactFunc'
import type { BasePromotion, DashboardData, PunchCard } from '../../../interface/DashboardData'

export class PunchCards extends BaseActivity {
    public async runMobile(data: DashboardData): Promise<void> {
        try {
            await this.run(data)
        } catch (error) {
            this.bot.logger.error(
                'main',
                'PUNCHCARD',
                `Mobile punchcards failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    public async runDesktop(): Promise<void> {
        if (!this.bot.config.workers.doPunchCards) return

        let data: DashboardData
        try {
            data = await this.bot.browser.func.getDashboardData(this.bot.cookies.desktop)
        } catch (error) {
            this.bot.logger.markWorkerFailure()
            this.bot.logger.warn(
                'main',
                'PUNCHCARD',
                `Desktop punchcard data unavailable | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        try {
            await this.run(data)
        } catch (error) {
            this.bot.logger.error(
                'main',
                'PUNCHCARD',
                `Desktop punchcards failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async run(data: DashboardData): Promise<void> {
        this.bot.punchCardsVerified = false
        const parents = await this.getParentQuests(true)
        if (!parents) return

        const apiById = new Map(
            (data.dashboard.punchCards ?? [])
                .filter(card => card.parentPromotion?.offerId)
                .map(card => [card.parentPromotion.offerId, card] as const)
        )

        this.mergeApiParents(parents, apiById)
        const pending = parents.filter(parent => {
            if (parent.complete) return false
            // Activation steps and app quests often have no points on the
            // parent card. The child lifecycle decides what is executable.
            return true
        })

        if (!pending.length) {
            this.bot.punchCardsVerified = parents.length > 0
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'No actionable quests')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Found ${pending.length} incomplete quest(s) | apiMatched=${pending.filter(parent => apiById.has(parent.offerId)).length}`
        )

        let verified = true
        for (const parent of pending) {
            try {
                if (!(await this.solvePunchCard(parent, apiById.get(parent.offerId)))) verified = false
            } catch (error) {
                verified = false
                this.bot.logger.error(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Error solving quest "${parent.title || parent.offerId}" | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            }
        }

        this.bot.punchCardsVerified = verified

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'Finished processing quests')
    }

    private async getParentQuests(rendered = false): Promise<ParentQuest[] | null> {
        try {
            const earn = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn')
            if (!earn) {
                this.bot.logger.markWorkerFailure()
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', '/earn unavailable - cannot list quests')
                return null
            }

            const parents = this.bot.browser.react.snapshotQuestList(earn)
            if (rendered && this.bot.browser.func.withRewardsPage) {
                const visible = await this.bot.browser.func.withRewardsPage(URLs.rewards.earn, readPunchCardParents)
                for (const card of visible ?? []) {
                    const existing = parents.find(parent => parent.offerId === card.offerId)
                    if (existing) Object.assign(existing, card)
                    else parents.push(card)
                }
            }
            if (parents.length) return parents

            const dashboard = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.dashboard, '/dashboard')
            return dashboard ? this.bot.browser.react.snapshotQuestList(earn, dashboard) : parents
        } catch (error) {
            this.bot.logger.markWorkerFailure()
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching quest list | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private mergeApiParents(parents: ParentQuest[], apiById: Map<string, PunchCard>): void {
        const seen = new Set(parents.map(parent => parent.offerId))

        for (const card of apiById.values()) {
            const promotion = card.parentPromotion
            if (!promotion?.offerId || seen.has(promotion.offerId)) continue

            parents.push({
                offerId: promotion.offerId,
                title: promotion.title ?? '',
                pointProgressMax: promotion.pointProgressMax ?? 0,
                complete: Boolean(promotion.complete)
            })
            seen.add(promotion.offerId)
        }

        for (const parent of parents) {
            if (parent.pointProgressMax > 0) continue
            parent.pointProgressMax = apiById.get(parent.offerId)?.parentPromotion?.pointProgressMax ?? 0
        }
    }

    private async solvePunchCard(parent: ParentQuest, apiCard: PunchCard | undefined): Promise<boolean> {
        const parentId = parent.offerId
        const title = parent.title || apiCard?.parentPromotion?.title || parentId
        let children = await this.getQuestChildren(parentId, title)
        if (!children) return false

        const apiChildById = new Map(
            (apiCard?.childPromotions ?? [])
                .filter(child => child.offerId)
                .map(child => [child.offerId, child] as const)
        )
        const startBalance = this.bot.userData.currentPoints
        let reported = 0
        const attempted = new Set<string>()
        const confirmed = new Set<string>()
        let completedTasks = parent.completedTasks
        // Activation and later unlocks must be read from a new response. Never
        // resend one child just because an acknowledgment did not credit points.
        while (attempted.size < 32) {
            const next = [...children]
                .sort(
                    (a, b) =>
                        Number(!/activate|start.*quest/i.test(a.title ?? a.offerId)) -
                            Number(!/activate|start.*quest/i.test(b.title ?? b.offerId)) ||
                        (apiChildById.get(a.offerId)?.priority ?? 999) - (apiChildById.get(b.offerId)?.priority ?? 999)
                )
                .find(
                    child =>
                        !attempted.has(child.offerId) &&
                        this.childReason(child, apiChildById.get(child.offerId)) === 'actionable'
                )
            if (!next) break
            const child = next
            const apiChild = apiChildById.get(child.offerId)
            attempted.add(child.offerId)
            if (this.isClaimChild(child.offerId, apiChild)) {
                await this.bot.activities.doClaimReward(child, parentId)
            } else {
                if (await this.reportQuestChild(child, parentId)) reported += 1
            }
            await waitForActivity(this.bot, this.bot.utils.randomDelay(5000, 15000))
            const fresh = await this.getQuestChildren(parentId, title)
            const freshParent = (await this.getParentQuests())?.find(p => p.offerId === parentId)
            if (freshParent?.complete) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Quest "${title}" COMPLETE | verified=true | reported=${reported}`
                )
                return true
            }
            if (
                completedTasks !== undefined &&
                freshParent?.completedTasks !== undefined &&
                freshParent.completedTasks > completedTasks &&
                fresh &&
                !fresh.some(item => item.offerId === child.offerId)
            )
                confirmed.add(child.offerId)
            completedTasks = freshParent?.completedTasks ?? completedTasks
            if (!fresh) {
                return false
            }
            for (const item of fresh) if (item.isCompleted) confirmed.add(item.offerId)
            children = fresh
        }
        const refreshedParents = await this.getParentQuests()
        const complete = refreshedParents?.some(p => p.offerId === parentId && p.complete) === true
        const unconfirmed = [...attempted].filter(id => !confirmed.has(id) && !complete)
        for (const child of children)
            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Quest step | quest=${parentId} | offerId=${child.offerId} | reason=${this.childReason(child, apiChildById.get(child.offerId))}`
            )
        const unresolved = children.some(child =>
            ['actionable', 'missing-hash', 'unsupported'].includes(
                this.childReason(child, apiChildById.get(child.offerId))
            )
        )
        const verified =
            complete ||
            (refreshedParents?.some(p => p.offerId === parentId) === true && unconfirmed.length === 0 && !unresolved)
        const gained = this.bot.userData.currentPoints - startBalance
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Quest "${title}" ${complete ? 'COMPLETE' : 'in progress'} | reported=${reported} | verified=${verified}` +
                ` | unconfirmed=${unconfirmed.length} | pointsGained=${gained}` +
                ` | currentBalance=${this.bot.userData.currentPoints}` +
                `${parent.pointProgressMax > 0 ? ` | targetPoints=${parent.pointProgressMax}` : ''}`,
            gained > 0 ? 'green' : undefined
        )
        return verified
    }

    private childReason(child: QuestChild, promotion?: BasePromotion): string {
        if (child.isCompleted) return 'completed'
        if (child.isLocked) return 'locked-prerequisite'
        if (child.isDisabled) return 'disabled'
        const text = `${child.title ?? ''} ${child.description ?? ''} ${child.unlockCriteria ?? ''}`
        if (
            this.isSearchQuotaChild(child.offerId, promotion) ||
            /(?:\d+\s*(?:out of|of)\s*\d+\s*days|24\s*hours? apart|search[\s\S]{0,100}\b(?:[2-9]|\d{2,}|seven|five|three)\s+days\b)/i.test(
                text
            )
        )
            return 'waiting-day-or-search'
        if (/rewardsapp.*(?:weekly|exclusive)|bing\.com\/apps\//i.test(`${child.offerId} ${child.destination ?? ''}`))
            return 'requires-app'
        if (this.isClaimChild(child.offerId, promotion) && !this.bot.config.autoClaimPunchcardRewards)
            return 'manual-claim'
        if (!child.hash) return 'missing-hash'
        const type = (child.promotionType || promotion?.promotionType || '').toLowerCase()
        if (type && !['urlreward', 'quiz', 'poll', 'puzzle', 'claim', 'redeem'].includes(type) && !child.activityType)
            return 'unsupported'
        return child.reportable ? 'actionable' : 'disabled'
    }

    private async getQuestChildren(parentId: string, title: string): Promise<QuestChild[] | null> {
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const html = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`)
            if (!html) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Quest page unavailable for "${title}"`)
                return null
            }

            const children = this.bot.browser.react.snapshotQuestPage(html)
            // v5 rendered fallback also covers streamed pages missing signed CTA props.
            if (!children.length && this.bot.browser.func.withRewardsPage) {
                const rendered = await this.bot.browser.func.withRewardsPage(questUrl, async page => ({
                    children: this.bot.browser.react.snapshotQuestPage(await page.content()),
                    page: await readPunchCardPage(page)
                }))
                if (rendered) for (const child of rendered.children) {
                    const candidates = rendered.page.steps.filter(step => step.offerId
                        ? step.offerId === child.offerId
                        : step.controlName === child.title && step.destination === child.destination)
                    if (candidates.length === 1) {
                        const step = candidates[0]!
                        child.description ||= step.description
                        child.isCompleted ||= step.complete
                        child.isDisabled ||= step.disabled
                        child.reportable &&= !child.isCompleted && !child.isDisabled
                    }
                    children.push(child)
                }
            }
            if (!children.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `No actionable children for "${title}"`)
                return null
            }
            return children
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching quest page for "${title}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private async reportQuestChild(child: QuestChild, parentId: string): Promise<boolean> {
        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Skip ${child.offerId}: "reportActivity" was not discovered`
            )
            return false
        }
        if (!child.hash) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${child.offerId}: no live hash`)
            return false
        }

        const oldBalance = this.bot.userData.currentPoints
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    child.activityType ?? 11,
                    {
                        offerid: child.offerId,
                        isPromotional: child.isPromotional ? 'true' : '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                {
                    url: questUrl,
                    browserFallback: true,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            if (newBalance === null) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Reported child but final balance is unknown | offerId=${child.offerId} | status=${status}`
                )
                return acknowledged
            }
            const freshHtml = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`)
            const fresh = freshHtml ? this.bot.browser.react.snapshotQuestPage(freshHtml).find(item => item.offerId === child.offerId) : undefined
            const progress = fresh && fresh.points === child.points ? pointDelta(child.pointProgress, fresh.pointProgress) : null
            const gained = acknowledged ? creditedPoints(progress, oldBalance, newBalance) : null
            this.bot.userData.currentPoints = newBalance
            if (gained !== null && gained > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Reported child | offerId=${child.offerId} | status=${status} | acknowledged=${acknowledged}` +
                    ` | pointsGained=${gained ?? 'unknown'} | currentBalance=${newBalance} | creditVerified=${gained !== null}`,
                gained !== null && gained > 0 ? 'green' : undefined
            )
            return acknowledged
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD',
                `Error reporting child | offerId=${child.offerId} | message=${
                    error instanceof Error ? error.message : String(error)
                }`
            )
            return false
        }
    }

    private isSearchQuotaChild(offerId: string, promotion?: BasePromotion): boolean {
        if (promotion) {
            const type = (promotion.promotionType ?? '').toLowerCase()
            const attributeType = String(this.getAttribute(promotion, 'type') ?? '').toLowerCase()
            if (type === 'search' || attributeType === 'search') return true
        }
        return (
            /(?:^|[_-])search(?:[_-]|$)/i.test(offerId) ||
            (/search/i.test(offerId) && /(day|streak|\dx)/i.test(offerId))
        )
    }

    private isClaimChild(offerId: string, promotion?: BasePromotion): boolean {
        if (['claim', 'redeem'].includes((promotion?.promotionType ?? '').toLowerCase())) return true
        if (/\/redeem\//.test((promotion?.destinationUrl ?? '').toLowerCase())) return true
        return /(?:^|[_-])(?:redeem|claim|reward)(?:[_-]|$)/i.test(offerId)
    }

    private getAttribute(promotion: BasePromotion, key: string): unknown {
        const attributes = promotion.attributes
        if (!attributes || typeof attributes !== 'object') return undefined
        return (attributes as Record<string, unknown>)[key]
    }
}
