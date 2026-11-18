import type { Page } from 'patchright'
import { REWARDS_BASE_URL, URLs } from '../../constants/urls'
import { runRewardsOnboarding } from '../../functions/RewardsOnboarding'
import type { Account } from '../../interface/Account'
import { saveStorageState } from '../../util/SessionStore'
import { mapFlyoutToDashboard, type RewardsFlyoutData } from '../FlyoutDashboard'
import { configureMediaBlocking } from '../MediaBlocker'
import { isAccountReviewUrl } from './AuthorizationRoute'
import type { Login } from './Login'

export async function hasStoredAuthCookies(page: Page): Promise<boolean> {
    try {
        const context = page.context()
        if (typeof context?.cookies !== 'function') return false
        const cookies = await context.cookies([URLs.rewards.origin, URLs.bing.origin, URLs.auth.loginLive])
        return cookies.some(
            cookie => ['_U', 'RPSSecAuth', '__Host-MSAAUTH'].includes(cookie.name) && Boolean(cookie.value)
        )
    } catch {
        return false
    }
}

export async function hasAuthenticatedRewardsPayload(host: Login, page: Page): Promise<boolean> {
    try {
        const { account } = host.bot.browser.react.snapshotPage(await page.content())
        const membership = [account.pointsProgress, account.pointsRemaining, account.lifetimeEarn]
        const membershipConfirmed =
            Number.isSafeInteger(account.level) &&
            Number(account.level) >= 1 &&
            membership.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        const firstVisit =
            !membershipConfirmed &&
            typeof page.getByRole === 'function' &&
            Number.isSafeInteger(account.level) &&
            Number(account.level) >= 1 &&
            [account.pointsProgress, account.pointsRemaining].every(
                value => typeof value === 'number' && Number.isFinite(value) && value >= 0
            ) &&
            (await page
                .getByRole('heading', { name: /welcome to\s*microsoft rewards/i })
                .first()
                .isVisible()
                .catch(() => false)) &&
            (await page
                .getByRole('button', { name: /^get started$/i })
                .first()
                .isVisible()
                .catch(() => false))
        const confirmed = membershipConfirmed || Boolean(firstVisit)
        if (confirmed) {
            host.bot.logger.info(
                host.bot.isMobile,
                'LOGIN',
                'Authenticated Rewards membership payload verified on the rendered page'
            )
        }
        return confirmed
    } catch {
        return false
    }
}

export async function hasAuthenticatedBingSession(host: Login, page: Page): Promise<boolean> {
    const cookies = await page
        .context()
        .cookies([URLs.bing.origin])
        .catch(() => [])
    if (!cookies.some(cookie => cookie.name === '_U' && Boolean(cookie.value))) return false
    const profile = await page
        .waitForSelector(host.selectors.bingProfile, { timeout: 1500 })
        .then(() => true)
        .catch(() => false)
    if (profile) return true

    try {
        const response = await page.request.get(URLs.bing.rewardsFlyoutUserInfo, { timeout: 5000 })
        if (response.status() !== 200) return false
        const result: RewardsFlyoutData = await response.json()
        mapFlyoutToDashboard(result)
        return true
    } catch {
        return false
    }
}

export async function verifyBingSession(host: Login, page: Page, account: Account): Promise<boolean> {
    const url = URLs.auth.bingSignIn
    const loopMax = 5

    host.bot.logger.info(host.bot.isMobile, 'LOGIN-BING', 'Verifying Bing session')

    try {
        await page.goto(URLs.bing.origin, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
        const landing = new URL(page.url())
        const bingLanding =
            (landing.hostname === 'bing.com' || landing.hostname.endsWith('.bing.com')) &&
            landing.hostname !== 'rewards.bing.com'
        if (bingLanding && (await host.hasAuthenticatedBingSession(page))) {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN-BING', 'Bing session verified from existing browser session')
            return true
        }
        if (page.isClosed()) return false
        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        for (let i = 0; i < loopMax; i++) {
            if (page.isClosed()) break

            host.bot.logger.debug(host.bot.isMobile, 'LOGIN-BING', `Verification loop ${i + 1}/${loopMax}`)

            if (isAccountReviewUrl(page.url())) {
                host.bot.logger.warn(
                    host.bot.isMobile,
                    'LOGIN-BING',
                    'Bing authorization redirected to account.live.com/Abuse; stopping this sign-in attempt without classifying the Rewards session as locked'
                )
                return false
            }
            const u = new URL(page.url())
            const hostname = u.hostname.toLowerCase()
            const atBingPage =
                (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && hostname !== 'rewards.bing.com'
            if (!atBingPage) {
                const state = await host.detectCurrentState(page)
                if (state === 'PASSKEY_ERROR') {
                    host.bot.logger.info(host.bot.isMobile, 'LOGIN-BING', 'Dismissing Passkey error state')
                    await host.bot.browser.utils.ghostClick(page, host.selectors.secondaryButton)
                }

                await host.handleState(state, page, account)
            }

            host.bot.logger.debug(
                host.bot.isMobile,
                'LOGIN-BING',
                `At Bing page: ${atBingPage} (${hostname}${u.pathname})`
            )

            if (atBingPage) {
                await host.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                const signedIn = await host.hasAuthenticatedBingSession(page)

                host.bot.logger.debug(host.bot.isMobile, 'LOGIN-BING', `Profile element found: ${signedIn}`)

                if (signedIn) {
                    host.bot.logger.info(host.bot.isMobile, 'LOGIN-BING', 'Bing session verified successfully')
                    return true
                }
            }

            await host.bot.utils.wait(1000)
        }

        host.bot.logger.warn(
            host.bot.isMobile,
            'LOGIN-BING',
            'Could not verify Bing session; Rewards and app authorization remain separate'
        )
    } catch (error) {
        host.bot.logger.warn(
            host.bot.isMobile,
            'LOGIN-BING',
            `Verification error: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    return false
}

export async function finalizeLogin(host: Login, page: Page, account: Account): Promise<void> {
    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Finalizing login')

    await page.goto(REWARDS_BASE_URL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

    const rewardsLanding = new URL(page.url())
    const rewardsHostname = rewardsLanding.hostname.toLowerCase()
    const loginRewardsSuccess = rewardsHostname === 'bing.com' || rewardsHostname.endsWith('.bing.com')
    if (loginRewardsSuccess) {
        if (rewardsHostname === 'rewards.bing.com') {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Logged into Microsoft Rewards successfully')
        } else {
            host.bot.logger.info(
                host.bot.isMobile,
                'LOGIN',
                `Rewards sign-in redirected to Bing home (${rewardsHostname}); continuing verification`
            )
        }
    } else {
        host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not verify Rewards Dashboard, assuming login valid')
    }

    await host.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})
    await runRewardsOnboarding(host.bot, page, account.newAccountMode === true)

    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Starting Bing session verification')
    const bingVerified = await host.verifyBingSession(page, account)
    if (!bingVerified) {
        host.bot.logger.warn(
            host.bot.isMobile,
            'LOGIN-BING',
            'Rewards sign-in is available, but Bing sign-in is unverified; app authorization is checked separately'
        )
    }

    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Acquiring rewards context')
    await getRewardsSession(host, page)

    const context = page.context()
    const storageState = await context.storageState()
    host.bot.logger.debug(
        host.bot.isMobile,
        'LOGIN',
        `Saving session | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
    )
    saveStorageState(host.bot.config.sessionPath, account.email, host.bot.isMobile, storageState)

    await configureMediaBlocking(host.bot, context)
    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Login completed, session saved')
}

export async function getRewardsSession(host: Login, page: Page): Promise<void> {
    host.bot.logger.info(host.bot.isMobile, 'GET-REWARD-SESSION', 'Bootstrapping rewards context')

    try {
        await host.bot.browser.func.bootstrap(page)

        const actionsCount = Object.keys(host.bot.nextActions).length
        const snapshot = host.bot.reactSnapshot
        const reportableCount = snapshot?.reportable.length ?? 0
        const availablePoints = snapshot?.account.availablePoints ?? null

        if (!actionsCount) {
            host.bot.logger.warn(
                host.bot.isMobile,
                'GET-REWARD-SESSION',
                'No action ids resolved - server-action calls (report/streak protection) will be skipped this run'
            )
        }

        if (!snapshot || !snapshot.offers.length) {
            host.bot.logger.warn(
                host.bot.isMobile,
                'GET-REWARD-SESSION',
                'Page snapshot empty - neither /earn nor /dashboard rendered a usable RSC payload'
            )
        }

        host.bot.logger.info(
            host.bot.isMobile,
            'GET-REWARD-SESSION',
            `Context ready | actions=${actionsCount} | reportable=${reportableCount} | available=${availablePoints}`
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        host.bot.logger.error(host.bot.isMobile, 'GET-REWARD-SESSION', `Failed to acquire rewards context: ${message}`)

        throw new Error(`Failed to acquire rewards context: ${message}`)
    }
}
