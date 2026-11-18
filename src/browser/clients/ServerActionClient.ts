import { URLs } from '../../constants/urls'
import type { MicrosoftRewardsBot } from '../../index'
import type BrowserFunc from '../BrowserFunc'
import type { CookieJarSync } from './CookieJarSync'
import type { RscBootstrapClient } from './RscBootstrapClient'

export class ServerActionClient {
    constructor(
        private readonly bot: MicrosoftRewardsBot,
        private readonly cookies: CookieJarSync,
        private readonly bootstrapClient: RscBootstrapClient,
        private readonly host: BrowserFunc
    ) {}

    public async reportServerAction(
        actionId: string,
        body: unknown[],
        opts?: { url?: string; referer?: string; routerStateTree?: string; browserFallback?: boolean }
    ): Promise<{ status: number; acknowledged: boolean; availablePoints: number | null }> {
        this.bot.normalSession?.assertActive()
        const url = opts?.url ?? URLs.rewards.earn
        const referer = opts?.referer ?? url
        const routerStateTree = opts?.routerStateTree ?? this.bot.nextRouterStateTree

        const fingerprintHeaders = { ...this.bot.fingerprint.headers }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        const headers = {
            ...fingerprintHeaders,
            Referer: referer,
            Origin: URLs.rewards.origin,
            Accept: 'text/x-component',
            'Content-Type': 'text/plain;charset=UTF-8',
            'Next-Action': actionId,
            'Next-Router-State-Tree': routerStateTree,
            ...(this.bootstrapClient.rewardsDeploymentId
                ? { 'X-Deployment-Id': this.bootstrapClient.rewardsDeploymentId }
                : {})
        }

        let response
        try {
            response = await this.bot.http.request({
                url,
                method: 'POST',
                headers: {
                    ...headers,
                    Cookie: this.cookies.buildCookieHeader(this.cookies.getCachedCookies(undefined, url))
                },
                data: JSON.stringify(body)
            })
        } catch (error) {
            const status = (error as { status?: number }).status
            const page = this.host.getActivePage()
            if (!opts?.browserFallback || status !== 503 || !page) throw error
            this.bot.logger.warn(
                this.bot.isMobile,
                'SERVER-ACTION',
                'HTTP transport returned 503; retrying once through the active browser context'
            )
            const browserResponse = await page.request.post(url, {
                headers,
                data: JSON.stringify(body),
                timeout: 20000
            })
            if (!browserResponse.ok()) {
                throw new Error(`Browser server action failed with status code ${browserResponse.status()}`)
            }
            await this.host.syncActiveCookies(page, 'SERVER-ACTION')
            const payload = await browserResponse.text()
            return {
                status: browserResponse.status(),
                acknowledged: this.bot.utils.serverActionAcknowledged(payload),
                availablePoints: this.bot.browser.react.availablePointsFromPayload(payload)
            }
        }
        await this.cookies.applyResponseCookies(url, response.headers['set-cookie'])

        return {
            status: response.status,
            acknowledged: this.bot.utils.serverActionAcknowledged(response.data),
            availablePoints: this.bot.browser.react.availablePointsFromPayload(response.data)
        }
    }
}
