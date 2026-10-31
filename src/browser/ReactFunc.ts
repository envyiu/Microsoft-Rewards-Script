import { pointValue } from '../util/PointAccounting'
import type { MicrosoftRewardsBot } from '../index'

export interface ParsedOffer {
    offerId: string
    hash: string | null
    title: string
    description: string
    points: number
    pointProgress?: number | null
    promotionSubtype: string | null
    promotionType?: string | null
    name?: string | null
    destination: string
    isCompleted: boolean
    isPromotional: boolean
    isLocked: boolean
    isDisabled?: boolean
    activityProgressMax?: number | null
    unlockCriteria: string | null
    date: string | null
    activityType: number | null
    reportable: boolean
}

export interface QuestChild {
    offerId: string
    hash: string | null
    points: number
    pointProgress?: number | null
    isCompleted: boolean
    isLocked: boolean
    isDisabled: boolean
    reportable: boolean
    title?: string
    description?: string
    destination?: string
    promotionType?: string | null
    activityType?: number | null
    isPromotional?: boolean
    unlockCriteria?: string | null
    activityProgressMax?: number | null
}

export interface ParentQuest {
    offerId: string
    title: string
    pointProgressMax: number
    complete: boolean
    completedTasks?: number
    totalTasks?: number
}

export interface StreakState {
    partner: string
    resetAt?: string | null
    activitiesCompleted: number
    activitiesTotal: number
    completedDays: number
    currentDay: number
    totalDays: number
    isCurrentDayCompleted: boolean
    isEnabled: boolean
    dailyPoints: number[]
    activationOfferId: string | null
    activationHash: string | null
    activationActivityType: number | null
    destinationUrl: string | null
}

export interface StreakProtectionState {
    isProtectionOn: boolean
    remainingDays: number | null
    streakCounter: number | null
}

export interface AccountState {
    level: number | null
    pointsProgress: number | null
    pointsRemaining: number | null
    lifetimeEarn: number | null
    availablePoints: number | null
}

export interface SearchPointsCounter {
    max: number
    progress: number
}

export interface SearchPointsCounters {
    pc: SearchPointsCounter | null
    mobile: SearchPointsCounter | null
}

export interface PageSnapshot {
    offers: ParsedOffer[]
    dailySet: ParsedOffer[] | null
    reportable: ParsedOffer[]
    streaks: StreakState[]
    streakProtection: StreakProtectionState | null
    dailyStreak: number | null
    unmatchedEarnCards?: number
    morePromotionsAvailable: boolean
    account: AccountState
}

export default class ReactFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    // Parse all available data from the provided pages into one snapshot
    public snapshotPage(html: string | readonly string[]): PageSnapshot {
        const combined = this.concatFlightChunks(html)

        const offers = this.parseOffers(combined)
        const dailySet = this.parseDailySet(combined)
        // The active set's expiry comes from Rewards, so it remains valid when
        // the worker's UTC date differs from the account's local day.
        for (const daily of dailySet ?? []) {
            const index = offers.findIndex(offer => offer.offerId === daily.offerId)
            if (index < 0) offers.push(daily)
            else offers[index] = daily
        }
        const streaks = this.parseStreaks(combined)
        const streakProtection = this.parseStreakProtection(combined)
        const dailyStreak = this.parseDailyStreak(combined)
        if (streakProtection) streakProtection.streakCounter = dailyStreak
        const account = this.parseAccountData(combined)
        const accountEmail = this.bot.currentAccountEmail

        if (accountEmail)
            this.bot.logger.info(
                this.bot.isMobile,
                'REWARDS-STREAK',
                JSON.stringify({
                    version: 1,
                    email: accountEmail,
                    dailyCounter: dailyStreak,
                    status: dailyStreak === null ? 'unknown' : 'fresh',
                    source: 'rewards-page',
                    observedAt: new Date().toISOString(),
                    partners: streaks.map(
                        ({
                            partner,
                            completedDays,
                            totalDays,
                            activitiesCompleted,
                            activitiesTotal,
                            isEnabled,
                            isCurrentDayCompleted
                        }) => ({
                            partner,
                            completedDays,
                            totalDays,
                            activitiesCompleted,
                            activitiesTotal,
                            isEnabled,
                            isCurrentDayCompleted
                        })
                    )
                })
            )

        this.bot.logger.info(
            this.bot.isMobile,
            'REACT-PARSE',
            `Snapshot complete | offers=${offers.length} | reportable=${offers.filter(o => o.reportable).length} | streaks=${streaks.length} | streakProtectionEnabled=${streakProtection?.isProtectionOn ?? 'null'} | streakProtectionRemainingDays=${streakProtection?.remainingDays ?? 'null'} | streakCounter=${dailyStreak ?? 'null'} | level=${account.level} | account=${accountEmail ?? 'null'}`
        )

        return {
            offers,
            dailySet,
            reportable: offers.filter(o => o.reportable),
            streaks,
            streakProtection,
            dailyStreak,
            morePromotionsAvailable: combined.includes('Earn_LevelUpSection') || offers.some(o => !!o.hash),
            account
        }
    }
    private parseDailySet(combined: string): ParsedOffer[] | null {
        const groups = this.extractObjects(combined, '"dailySetItems"')
        const offers = new Map<string, ParsedOffer>()
        let confirmed = false
        for (const group of groups) {
            if (!Array.isArray(group.dailySetItems)) continue
            const expires = typeof group.expiresAt === 'string' ? group.expiresAt.replace(/^\$D/, '') : ''
            const expiry = Date.parse(expires)
            if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 48 * 60 * 60_000) continue
            if (
                group.dailySetItems.some(
                    item =>
                        !item ||
                        typeof item !== 'object' ||
                        typeof item.isCompleted !== 'boolean' ||
                        typeof item.offerId !== 'string' ||
                        !item.offerId ||
                        typeof item.points !== 'number' ||
                        !Number.isFinite(item.points) ||
                        item.points < 0 ||
                        (this.normaliseDate(item.date) ?? '') > expires.slice(0, 10)
                )
            )
                continue
            confirmed = true
            for (const offer of this.parseOffers(JSON.stringify(group.dailySetItems))) {
                if (offer.date && offer.date > expires.slice(0, 10)) continue
                offer.reportable = Boolean(offer.hash) && !offer.isCompleted && !offer.isLocked
                offers.set(offer.offerId, offer)
            }
        }
        return confirmed ? [...offers.values()] : null
    }
    public getStreakProtection(html: string): StreakProtectionState | null {
        return this.parseStreakProtection(this.concatFlightChunks(html))
    }

    public buildId(html: string): string | null {
        const combined = this.concatFlightChunks(html)
        return (
            html.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ??
            combined.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ??
            combined.match(/"buildId":"([A-Za-z0-9._-]+)"/)?.[1] ??
            combined.match(/"b":"([A-Za-z0-9._-]{8,})"/)?.[1] ??
            html.match(/\/_next\/static\/([A-Za-z0-9._-]+)\//)?.[1] ??
            null
        )
    }

    public availablePointsFromPayload(payload: unknown): number | null {
        if (typeof payload !== 'string') return null

        const normalized = payload.replace(/\\"/g, '"')
        const matches = [...normalized.matchAll(/"availablePoints"\s*:\s*(\d+)/g)]
        const value = Number(matches.at(-1)?.[1])

        return Number.isSafeInteger(value) && value >= 0 ? value : null
    }

    public searchCountersFromEarnPage(html: string): SearchPointsCounters | null {
        const combined = this.concatFlightChunks(html)
        const models = this.extractObjects(combined, '"pointsCounters"')

        for (const model of models) {
            const counters = model.pointsCounters
            if (!counters || typeof counters !== 'object') continue
            const values = counters as Record<string, unknown>
            const pc = this.parseSearchPointsCounter(values.pc)
            const mobile = this.parseSearchPointsCounter(values.mobile)
            if (pc || mobile) return { pc, mobile }
        }

        return null
    }

    private parseSearchPointsCounter(value: unknown): SearchPointsCounter | null {
        if (!value || typeof value !== 'object') return null
        const counter = value as Record<string, unknown>
        const max = Number(counter.max)
        const progress = Number(counter.progress)
        if (!Number.isFinite(max) || max < 0 || !Number.isFinite(progress) || progress < 0) return null
        return { max, progress }
    }

    private concatFlightChunks(html: string | readonly string[]): string {
        try {
            const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g
            const pages = typeof html === 'string' ? [html] : html
            const perPage: string[] = []
            let combined = ''
            let count = 0

            for (const page of pages) {
                let pageChunks = 0
                let source = ''

                for (const match of page.matchAll(pushRe)) {
                    try {
                        // Re-wrap in quotes so JSON.parse decodes
                        source += JSON.parse(`"${match[1]}"`)
                        count++
                        pageChunks++
                    } catch (err) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'REACT-PARSE',
                            `Skipped undecodable flight chunk | error=${err instanceof Error ? err.message : String(err)}`
                        )
                    }
                }

                // Flight record IDs are local to each response. Resolving after
                // joining /earn and /dashboard lets one page overwrite the other.
                if (pageChunks > 0) combined += this.resolveFlightReferences(source) + '\n'
                perPage.push(`${pageChunks}c/${source.length}b`)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Concatenated flight chunks | pages=${pages.length} | chunks=${count} | length=${combined.length} | perSource=[${perPage.join(', ')}]`
            )

            if (count === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'REACT-PARSE',
                    'No __next_f flight chunks found - page may not be an RSC render or markup changed'
                )
            }

            return combined
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed concatenating flight chunks | error=${error instanceof Error ? error.message : String(error)}`
            )
            return ''
        }
    }

    // Next Flight may store card fields in separate records (e.g. attributes: "$a").
    // Resolve data references before scanning offers so hashes, points and activity types stay together.
    private resolveFlightReferences(combined: string): string {
        const records = new Map<string, unknown>()
        const lines = combined.split('\n')
        for (const line of lines) {
            const match = line.match(/^([0-9a-f]+):(.*)$/i)
            if (!match) continue
            try {
                records.set(match[1]!, JSON.parse(match[2]!))
            } catch {}
        }
        let budget = 100_000
        const resolve = (value: unknown, path: Set<string>, depth: number): unknown => {
            if (--budget < 0 || depth > 30) return value
            if (typeof value === 'string') {
                const ref = value.match(/^\$(?:L)?([0-9a-f]+)(?::(.+))?$/i)
                const id = ref?.[1]
                if (!id || !records.has(id) || path.has(id)) return value
                let target = records.get(id)
                for (const key of ref?.[2]?.split(':') ?? []) {
                    if (!target || typeof target !== 'object' || !Object.prototype.hasOwnProperty.call(target, key))
                        return value
                    target = (target as Record<string, unknown>)[key]
                }
                return resolve(target, new Set([...path, id]), depth + 1)
            }
            if (Array.isArray(value)) return value.map(item => resolve(item, path, depth + 1))
            if (value && typeof value === 'object') {
                return Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [key, resolve(item, path, depth + 1)])
                )
            }
            return value
        }
        return lines
            .map(line => {
                const id = line.match(/^([0-9a-f]+):(?:\[|\{)/i)?.[1]
                return id && records.has(id)
                    ? `${id}:${JSON.stringify(resolve(records.get(id), new Set([id]), 0))}`
                    : line
            })
            .join('\n')
    }

    // Find every object containing "anchor" and return them as parsed JSON
    private extractObjects(combined: string, anchor: string): Record<string, unknown>[] {
        const out: Record<string, unknown>[] = []
        const anchorKey = anchor.replace(/^"|"$/g, '')
        let cursor = 0
        let failures = 0

        while (cursor < combined.length) {
            const anchorIndex = combined.indexOf(anchor, cursor)
            if (anchorIndex === -1) break

            cursor = anchorIndex + anchor.length
            let start = combined.lastIndexOf('{', anchorIndex)
            let extracted = false

            while (start !== -1) {
                let depth = 0
                let end = -1
                let inStr = false
                let esc = false

                for (let j = start; j < combined.length; j++) {
                    const c = combined[j]
                    if (esc) {
                        esc = false
                        continue
                    }
                    if (inStr && c === '\\') {
                        esc = true
                        continue
                    }
                    if (c === '"') {
                        inStr = !inStr
                        continue
                    }
                    if (inStr) continue
                    if (c === '{') depth++
                    else if (c === '}') {
                        depth--
                        if (depth === 0) {
                            end = j
                            break
                        }
                    }
                }

                if (end >= anchorIndex) {
                    const raw = combined.slice(start, end + 1)

                    try {
                        const parsed = JSON.parse(raw.replace(/"\$undefined"/g, 'null')) as Record<string, unknown>
                        if (Object.prototype.hasOwnProperty.call(parsed, anchorKey)) {
                            out.push(parsed)
                            cursor = Math.max(cursor, end + 1)
                            extracted = true
                            break
                        }
                    } catch {}
                }

                start = combined.lastIndexOf('{', start - 1)
            }

            if (!extracted) failures++
        }

        if (failures > 0) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `extractObjects("${anchor}") had ${failures} unparseable matches`
            )
        }

        return out
    }

    // Section parsers
    private parseOffers(combined: string): ParsedOffer[] {
        try {
            const today = this.todayStamp()
            const offers = new Map<string, ParsedOffer>()

            for (const obj of this.extractObjects(combined, '"offerId"')) {
                const offerId = obj.offerId as string | undefined
                if (!offerId) continue

                const hash = (obj.hash as string | null) ?? null
                const isCompleted = ((obj.isCompleted ?? obj.complete) as boolean | undefined) === true
                const isLocked =
                    obj.isLocked === true || obj.isDisabled === true || obj.exclusiveLockedFeatureStatus === 'locked'
                const date = this.normaliseDate(obj.date as string | undefined)
                const attributes =
                    obj.attributes && typeof obj.attributes === 'object'
                        ? (obj.attributes as Record<string, unknown>)
                        : null
                const activityTypeValue =
                    obj.activityType ?? obj.activity_type ?? attributes?.activityType ?? attributes?.activity_type
                const parsedActivityType = Number(activityTypeValue)
                const promotionalValue = obj.isPromotional ?? attributes?.promotional
                const isPromotional =
                    promotionalValue === true ||
                    (typeof promotionalValue === 'string' && promotionalValue.toLowerCase() === 'true')

                // Never try future-dated offers, lol
                const reportable = !!hash && !isCompleted && !isLocked && (date === null || date <= today)

                const candidate: ParsedOffer = {
                    offerId,
                    hash,
                    title: (obj.title as string) || (obj.ariaLabel as string) || (obj.linkText as string) || '',
                    description: (obj.description as string) ?? '',
                    points: (() => {
                        const points = Number(obj.points ?? obj.pointProgressMax ?? 0)
                        return Number.isFinite(points) && points >= 0 ? points : 0
                    })(),
                    pointProgress: pointValue(obj.pointProgress ?? attributes?.pointprogress),
                    promotionSubtype: (obj.promotionSubtype as string | null) ?? null,
                    promotionType: (obj.promotionType as string | null) ?? null,
                    name: (obj.name as string | null) ?? null,
                    destination:
                        (obj.destination as string) || (obj.destinationUrl as string) || (obj.href as string) || '',
                    isCompleted,
                    isPromotional,
                    isLocked,
                    isDisabled: obj.isDisabled === true,
                    activityProgressMax: typeof obj.activityProgressMax === 'number' ? obj.activityProgressMax : null,
                    unlockCriteria: (obj.unlockCriteria as string | null) ?? null,
                    date,
                    activityType:
                        Number.isInteger(parsedActivityType) && parsedActivityType > 0 ? parsedActivityType : null,
                    reportable
                }

                const existing = offers.get(offerId)
                if (!existing) {
                    offers.set(offerId, candidate)
                    continue
                }

                existing.pointProgress ??= candidate.pointProgress
                existing.hash ??= candidate.hash
                existing.title ||= candidate.title
                existing.description ||= candidate.description
                existing.points ||= candidate.points
                existing.promotionType ??= candidate.promotionType
                existing.name ??= candidate.name
                existing.promotionSubtype ??= candidate.promotionSubtype
                existing.destination ||= candidate.destination
                existing.isCompleted ||= candidate.isCompleted
                existing.isPromotional ||= candidate.isPromotional
                existing.isLocked ||= candidate.isLocked
                existing.isDisabled ||= candidate.isDisabled
                existing.activityProgressMax ??= candidate.activityProgressMax
                existing.unlockCriteria ??= candidate.unlockCriteria
                existing.date ??= candidate.date
                existing.activityType ??= candidate.activityType
                existing.reportable =
                    !!existing.hash &&
                    !existing.isCompleted &&
                    !existing.isLocked &&
                    (existing.date === null || existing.date <= today)
            }

            const unique = [...offers.values()]

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed offers | total=${unique.length} | reportable=${unique.filter(o => o.reportable).length}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed offer ids | ${unique.map(o => `${o.offerId}${o.reportable ? '' : '(skip)'}`).join(', ') || 'none'}`
            )

            return unique
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing offers | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private parseStreaks(combined: string): StreakState[] {
        try {
            const resetTimes = new Map<string, string>()
            for (const carrier of this.extractObjects(combined, '"expiresAt"')) {
                const streak = carrier.streak as Record<string, unknown> | undefined
                if (typeof streak?.partner !== 'string' || typeof carrier.expiresAt !== 'string') continue
                const reset = Date.parse(carrier.expiresAt.replace(/^\$D/, ''))
                if (Number.isFinite(reset)) resetTimes.set(streak.partner, new Date(reset).toISOString())
            }
            const count = (value: unknown): number => {
                const n = pointValue(value)
                return n !== null && Number.isSafeInteger(n) ? n : 0
            }
            const streaks = this.extractObjects(combined, '"dailyPoints"')
                .filter(o => typeof o.partner === 'string' && Array.isArray(o.dailyPoints))
                .map<StreakState>(o => ({
                    partner: o.partner as string,
                    resetAt: resetTimes.get(o.partner as string) ?? null,
                    activitiesCompleted: count(o.activitiesCompleted),
                    activitiesTotal: count(o.activitiesTotal),
                    completedDays: count(o.completedDays),
                    currentDay: count(o.currentDay),
                    totalDays: count(o.totalDays),
                    isCurrentDayCompleted: (o.isCurrentDayCompleted as boolean | undefined) === true,
                    isEnabled: (o.isEnabled as boolean | undefined) === true,
                    dailyPoints: (o.dailyPoints as unknown[]).map(count),
                    activationOfferId:
                        typeof o.activationOfferId === 'string' && o.activationOfferId !== '$undefined'
                            ? o.activationOfferId
                            : null,
                    activationHash:
                        typeof o.activationHash === 'string' && o.activationHash !== '$undefined'
                            ? o.activationHash
                            : null,
                    activationActivityType: (() => {
                        const parsed = Number(o.activationActivityType)
                        return Number.isInteger(parsed) && parsed > 0 ? parsed : null
                    })(),
                    destinationUrl:
                        typeof o.destinationUrl === 'string' && o.destinationUrl !== '$undefined'
                            ? o.destinationUrl
                            : null
                }))

            // de-dupe on partner
            const byPartner = new Map(streaks.filter(s => !s.resetAt || Date.parse(s.resetAt) > Date.now()).map(s => [s.partner, s]))
            const unique = [...byPartner.values()]

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed streaks | ${unique.map(s => `${s.partner}:${s.completedDays}/${s.totalDays}`).join(', ') || 'none'}`
            )

            return unique
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing streaks | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private parseStreakProtection(combined: string): StreakProtectionState | null {
        try {
            const carriers = this.extractObjects(combined, '"isProtectionOn"').filter(o => 'isProtectionOn' in o)
            if (!carriers.length) return null

            // The flag and remainingDays
            const withDays = carriers.find(o => 'remainingDays' in o && typeof o.remainingDays === 'number')
            const withFlag = carriers.find(o => typeof o.isProtectionOn === 'boolean')
            const withStreakCounter = carriers.find(o => 'streakCounter' in o && typeof o.streakCounter === 'number')

            const state: StreakProtectionState = {
                isProtectionOn: (withDays?.isProtectionOn ?? withFlag?.isProtectionOn) === true,
                remainingDays: withDays ? (withDays.remainingDays as number) : null,
                streakCounter: withStreakCounter ? (withStreakCounter.streakCounter as number) : null
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed streak protection | enabled=${state.isProtectionOn} | remainingDays=${state.remainingDays ?? 'null'} | streakCounter=${state.streakCounter}`
            )

            return state
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing streak protection | error=${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private parseDailyStreak(combined: string): number | null {
        // Daily streak is rendered separately from the protection switch.
        // Keep zero distinct from an absent/malformed counter.
        for (const obj of this.extractObjects(combined, '"streakCounter"')) {
            if (
                typeof obj.streakCounter === 'number' &&
                Number.isSafeInteger(obj.streakCounter) &&
                obj.streakCounter >= 0
            )
                return obj.streakCounter
        }
        return null
    }

    private parseAccountData(combined: string): AccountState {
        const empty: AccountState = {
            level: null,
            pointsProgress: null,
            pointsRemaining: null,
            lifetimeEarn: null,
            availablePoints: null
        }

        try {
            const membership =
                this.extractObjects(combined, '"pointsProgress"').find(
                    o => 'pointsRemaining' in o || 'lifetimeEarn' in o
                ) ?? {}

            // availablePoints renders in a separate header object
            const header = this.extractObjects(combined, '"availablePoints"').find(o => 'availablePoints' in o) ?? {}

            const account: AccountState = {
                level: (membership.level as number) ?? null,
                pointsProgress: (membership.pointsProgress as number) ?? null,
                pointsRemaining: (membership.pointsRemaining as number) ?? null,
                lifetimeEarn: (membership.lifetimeEarn as number) ?? null,
                availablePoints: (header.availablePoints as number) ?? (membership.availablePoints as number) ?? null
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed account | level=${account.level} | available=${account.availablePoints} | toGo=${account.pointsRemaining} | lifetime=${account.lifetimeEarn}`
            )

            if (account.level === null && account.availablePoints === null) {
                // Common error! Keep however for debugging!
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'REACT-PARSE',
                    'Account state empty - membership/header objects not found in payload'
                )
            }

            return account
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing account | error=${error instanceof Error ? error.message : String(error)}`
            )
            return empty
        }
    }

    public routerStateTree(segment: string): string {
        const refreshFlag = 4096
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [
                            segment,
                            { children: ['PAGE', {}, null, null, refreshFlag] },
                            null,
                            null,
                            refreshFlag
                        ]
                    },
                    null,
                    null,
                    refreshFlag
                ]
            },
            null,
            null,
            refreshFlag + 16
        ]
        return encodeURIComponent(JSON.stringify(tree))
    }

    public questRouterStateTree(questId: string): string {
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [
                            'earn',
                            {
                                children: [
                                    'quest',
                                    {
                                        children: [
                                            ['questId', questId, 'd', null],
                                            { children: ['__PAGE__', {}, null, null, 0] },
                                            null,
                                            null,
                                            0
                                        ]
                                    },
                                    null,
                                    null,
                                    0
                                ]
                            },
                            null,
                            null,
                            0
                        ]
                    },
                    null,
                    null,
                    0
                ]
            },
            null,
            null,
            16
        ]
        return encodeURIComponent(JSON.stringify(tree))
    }

    // Pull server-action ids out of a JS chunk
    public extractActionIds(jsText: string): {
        byName: Record<string, string>
        all: string[]
    } {
        const byName: Record<string, string> = {}
        const all = new Set<string>()

        // SHA-1 today (40 hex), allow growth to SHA-256 (64 hex)
        const HEX = '[a-f0-9]{40,64}'

        // Framework args that share the call shape but aren't the action name
        const KNOWN_NON_NAMES = new Set(['callServer', 'findSourceMapURL', 'encodeFormAction', 'default'])

        try {
            // Support for both formats: (createServerReference)(id) and createServerReference(id)
            // The argument search window has been expanded to 800 characters for Turbopack
            const createRegex = new RegExp(
                `createServerReference\\s*\\)?\\s*\\(\\s*"(${HEX})"([\\s\\S]{0,800}?)\\)`,
                'g'
            )
            const registerRegex = new RegExp(
                `registerServerReference\\s*\\)?\\s*\\([^,]+,\\s*"(${HEX})"([\\s\\S]{0,800}?)\\)`,
                'g'
            )

            const strLitRe = /"([A-Za-z_$][\w$]*)"/g

            const processMatches = (matches: IterableIterator<RegExpMatchArray>) => {
                for (const m of matches) {
                    const id = m[1]!
                    const argsBlock = m[2] ?? ''
                    all.add(id)

                    const candidates = [...argsBlock.matchAll(strLitRe)]
                        .map(x => x[1]!)
                        .filter(n => !KNOWN_NON_NAMES.has(n) && n.length > 3)

                    if (candidates.length) {
                        byName[candidates[candidates.length - 1]!] = id
                    }
                }
            }

            processMatches(jsText.matchAll(createRegex))
            processMatches(jsText.matchAll(registerRegex))

            const bareCreateRegex = new RegExp(`createServerReference\\s*\\)?\\s*\\(\\s*"(${HEX})"`, 'g')
            const bareRegisterRegex = new RegExp(`registerServerReference\\s*\\)?\\s*\\([^,]+,\\s*"(${HEX})"`, 'g')

            for (const m of jsText.matchAll(bareCreateRegex)) all.add(m[1]!)
            for (const m of jsText.matchAll(bareRegisterRegex)) all.add(m[1]!)

            const actionIdRe = new RegExp(`\\$ACTION_ID_(${HEX})`, 'g')
            for (const m of jsText.matchAll(actionIdRe)) all.add(m[1]!)

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Extracted action ids | named=${Object.keys(byName).length} | total=${all.size}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed extracting action ids | error=${error instanceof Error ? error.message : String(error)}`
            )
        }

        return { byName, all: [...all] }
    }

    // Quest pages (punchcards)
    public snapshotQuestPage(html: string): QuestChild[] {
        try {
            const combined = this.concatFlightChunks(html)
            const children = this.parseQuestOffers(combined)

            this.bot.logger.info(
                this.bot.isMobile,
                'REACT-PARSE',
                `Quest snapshot | children=${children.length} | reportable=${children.filter(c => c.reportable).length}`
            )

            return children
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing quest page | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private parseQuestOffers(combined: string): QuestChild[] {
        const out = this.parseOffers(combined)
            .filter(
                offer =>
                    !this.isParentQuestId(offer.offerId) &&
                    (/pcchild/i.test(offer.offerId) || (!!offer.hash && !!offer.title))
            )
            .map(offer => ({ ...offer, isDisabled: offer.isDisabled === true }))
        // The CTA props carry the signed offer; prerequisites and multi-day
        // instructions live in the enclosing rendered step, not in those props.
        const descriptions = new Map<string, string>()
        for (const container of this.extractObjects(combined, '"className"')) {
            const serialized = JSON.stringify(container.children)
            if (!serialized || serialized.length > 30_000) continue
            const ids = [...new Set([...serialized.matchAll(/"offerId":"([^"]+)"/g)].map(m => m[1]!))]
            if (ids.length !== 1) continue
            const child = out.find(item => item.offerId === ids[0])
            if (!child) continue
            const text = this.reactText(container.children).trim()
            if (text.length <= (child.title?.length ?? 0) || text.length > 1500) continue
            const prev = descriptions.get(child.offerId)
            if (!prev || text.length < prev.length) descriptions.set(child.offerId, text)
        }
        for (const child of out) child.description ||= descriptions.get(child.offerId) || ''

        this.bot.logger.debug(
            this.bot.isMobile,
            'REACT-PARSE',
            `Parsed quest children | total=${out.length} | reportable=${out.filter(c => c.reportable).length}`
        )

        return out
    }

    public snapshotQuestList(...htmls: string[]): ParentQuest[] {
        try {
            const combined = this.concatFlightChunks(htmls)

            // Read each card's own resolved React subtree. A fixed-size slice
            // around a URL can spill into the next card or omit a lazy child.
            const cards = new Map<string, ParentQuest>()
            for (const obj of this.extractObjects(combined, '"href"')) {
                const id =
                    typeof obj.href === 'string' ? obj.href.match(/^\/earn\/quest\/([A-Za-z0-9_-]+)$/)?.[1] : null
                if (!id) continue
                const text = this.reactText(obj.children)
                const task = text.match(/(\d+)\s*\/\s*(\d+)\s*tasks/i)
                const subtree = JSON.stringify(obj.children)
                const title = subtree.match(/"alt":"((?:[^"\\]|\\.)*)"/)?.[1] ?? ''
                const points = subtree.match(/"children":\["(?:\+)?","([\d,]+)"\]/)
                const prev = cards.get(id)
                cards.set(id, {
                    offerId: id,
                    title: title || prev?.title || '',
                    pointProgressMax: points ? Number(points[1]!.replace(/,/g, '')) : (prev?.pointProgressMax ?? 0),
                    complete: task
                        ? Number(task[1]) >= Number(task[2]) && Number(task[2]) > 0
                        : (prev?.complete ?? false),
                    completedTasks: task ? Number(task[1]) : prev?.completedTasks,
                    totalTasks: task ? Number(task[2]) : prev?.totalTasks
                })
            }
            if (cards.size) return [...cards.values()]

            const anchors: { id: string; at: number }[] = []
            for (const match of combined.matchAll(/\/earn\/quest\/([A-Za-z0-9_]+)/g)) {
                anchors.push({ id: match[1] as string, at: match.index ?? 0 })
            }
            for (const match of combined.matchAll(/"id":"quest_([A-Za-z0-9_]+)"/g)) {
                anchors.push({ id: match[1] as string, at: match.index ?? 0 })
            }
            for (const match of combined.matchAll(/[A-Za-z0-9_]*pcparent[A-Za-z0-9_]*/gi)) {
                anchors.push({ id: match[0] as string, at: match.index ?? 0 })
            }
            anchors.sort((a, b) => a.at - b.at)

            const byId = new Map<string, ParentQuest>()
            for (let k = 0; k < anchors.length; k++) {
                const { id, at } = anchors[k]!
                if (!this.isParentQuestId(id)) continue

                const next = anchors[k + 1]?.at ?? combined.length
                const region = combined.slice(at, Math.min(next, at + 3000))

                const title =
                    region.match(/"alt":"((?:[^"\\]|\\.)*)"/)?.[1] ??
                    region.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] ??
                    ''

                const pointsMatch = region.match(/\["\+","([\d,]+)"\]/)
                const points = pointsMatch ? Number(pointsMatch[1]!.replace(/,/g, '')) : 0
                const taskM = region.match(/(\d+)\s*\/\s*(\d+)\s*tasks/)
                const complete = !!taskM && Number(taskM[1]) >= Number(taskM[2]!) && Number(taskM[2]) > 0

                // First wins for title/points
                const prev = byId.get(id)
                byId.set(id, {
                    offerId: id,
                    title: prev?.title || title,
                    pointProgressMax: prev?.pointProgressMax || points,
                    complete: prev?.complete || complete
                })
            }

            const out = [...byId.values()]
            this.bot.logger.info(
                this.bot.isMobile,
                'REACT-PARSE',
                `Quest list | parents=${out.length} | incomplete=${out.filter(q => !q.complete).length}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Quest points | ${out.map(q => `${q.title || q.offerId}=${q.pointProgressMax}`).join(' | ') || 'none'}`
            )
            if (!out.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'REACT-PARSE',
                    'No parent quests parsed - the fetched HTML may be missing the QuestSection chunks (Suspense/streaming or a login redirect)'
                )
            }
            return out
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing quest list | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private reactText(value: unknown): string {
        if (typeof value === 'string') return value.startsWith('$') ? '' : value
        if (Array.isArray(value)) {
            if (value[0] === '$') return this.reactText((value[3] as Record<string, unknown> | undefined)?.children)
            return value.map(item => this.reactText(item)).join(' ')
        }
        if (value && typeof value === 'object') return this.reactText((value as Record<string, unknown>).children)
        return ''
    }

    // <campaign>_pcparent_<name>_punchcard
    private isParentQuestId(offerId: string): boolean {
        const id = offerId.toLowerCase()
        if (id.includes('pcchild')) return false
        return id.includes('pcparent') || id.includes('punchcard')
    }

    // Utils
    private todayStamp(): string {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    private normaliseDate(rawDate: string | undefined): string | null {
        if (!rawDate) return null
        const iso = rawDate.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/)
        if (iso) return iso[1]!
        const m = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        if (!m) return null
        return `${m[3]}-${m[1]}-${m[2]}`
    }
}
