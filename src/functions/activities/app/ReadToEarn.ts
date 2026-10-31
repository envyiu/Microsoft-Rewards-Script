import { waitForActivity } from '../../../util/ActivityTiming'
import { URLs } from '../../../constants/urls'
import { BING_APP_USER_AGENT } from '../../../constants/userAgents'
import { randomBytes } from 'crypto'
import { BaseActivity } from '../BaseActivity'

export interface ReadToEarnState {
    offered: boolean
    max: number
    progress: number
    remaining: number
    balance: number | null
}
function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}
function counter(value: unknown): number | null {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : null
}
export function parseReadToEarnState(data: unknown): ReadToEarnState | null {
    const response = record(record(data)?.response)
    if (!response || !Array.isArray(response.promotions)) return null
    const promotion = response.promotions
        .map(record)
        .find(p => record(p?.attributes)?.offerid === 'ENUS_readarticle3_30points')
    if (!promotion) return { offered: false, max: 0, progress: 0, remaining: 0, balance: counter(response.balance) }
    const attrs = record(promotion.attributes)
    const max = counter(attrs?.pointmax),
        progress = counter(attrs?.pointprogress ?? attrs?.progress)
    if (max === null || progress === null || progress > max) return null
    return { offered: true, max, progress, remaining: max - progress, balance: counter(response.balance) }
}

export class ReadToEarn extends BaseActivity {
    public async doReadToEarn() {
        this.bot.readToEarnVerified = false
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'READ-TO-EARN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }
        const delayMin = this.bot.config.searchSettings.readDelay.min
        const delayMax = this.bot.config.searchSettings.readDelay.max
        const startBalance = this.bot.userData.currentPoints
        const readState = async () => parseReadToEarnState(await this.bot.browser.func.getAppDashboardData('SAAndroid'))
        try {
            let state = await readState()
            if (!state?.offered || state.max <= 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    'Read to Earn quota unavailable; leaving task pending'
                )
                return
            }
            if (state.remaining === 0) {
                this.bot.readToEarnVerified = true
                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read to Earn already complete | progress=${state.progress}/${state.max}`
                )
                return
            }
            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Starting Read to Earn | geo=${this.bot.userData.geoLocale} | delayRange=${delayMin}-${delayMax} | currentBalance=${startBalance} | remaining=${state.remaining}`
            )
            let totalGained = 0,
                articlesRead = 0,
                stagnant = 0
            for (let i = 0; i < 10 && state.remaining > 0; i++) {
                const response = await this.bot.http.request<{ response?: { balance?: number } }>({
                    url: URLs.platform.activities,
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'User-Agent': BING_APP_USER_AGENT,
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': this.bot.userData.geoLocale,
                        'X-Rewards-Language': this.bot.userData.langCode,
                        'X-Rewards-ismobile': 'true'
                    },
                    data: JSON.stringify({
                        amount: 1,
                        id: randomBytes(64).toString('hex'),
                        type: 101,
                        attributes: { offerid: 'ENUS_readarticle3_30points' },
                        country: this.bot.userData.geoLocale
                    })
                })
                let updated = await readState()
                for (let poll = 0; poll < 2 && updated?.offered && updated.progress === state.progress; poll++) {
                    await this.bot.utils.wait(1000)
                    updated = await readState()
                }
                if (!updated?.offered || updated.max !== state.max || updated.progress < state.progress) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        'Could not verify article progress; leaving task pending'
                    )
                    break
                }
                const gainedPoints = updated.progress - state.progress
                const balances = [counter(response.data?.response?.balance), updated.balance].filter(
                    (n): n is number => n !== null
                )
                if (balances.length)
                    this.bot.userData.currentPoints = Math.max(this.bot.userData.currentPoints, ...balances)
                state = updated
                if (gainedPoints > 0) {
                    stagnant = 0
                    articlesRead++
                    totalGained += gainedPoints
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `Read article ${articlesRead}/10 | status=${response.status} | pointsGained=${gainedPoints} | currentBalance=${this.bot.userData.currentPoints}`,
                        'green'
                    )
                } else {
                    stagnant++
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `No article progress | attempts=${stagnant}/3 | remaining=${state.remaining}`
                    )
                    if (stagnant >= 3) break
                }
                if (state.remaining > 0 && i < 9) {
                    await waitForActivity(this.bot, this.bot.utils.randomDelay(delayMin, delayMax))
                }
            }
            this.bot.readToEarnVerified = state.remaining === 0
            if (this.bot.readToEarnVerified)
                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Completed Read to Earn | articlesRead=${articlesRead} | pointsGained=${totalGained} | previousBalance=${startBalance} | currentBalance=${this.bot.userData.currentPoints}`
                )
            else
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Completion not verified | articlesRead=${articlesRead} | remaining=${state.remaining}`
                )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Error during Read to Earn | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
