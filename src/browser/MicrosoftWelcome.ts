import type { Page } from 'patchright'

const HOSTS = new Set([
    'onedrive.live.com',
    'to-do.live.com',
    'to-do.microsoft.com',
    'todo.microsoft.com',
    'todo.cloud.microsoft',
    'to-do.office.com',
    'outlook.live.com',
    'account.microsoft.com',
    'privacynotice.account.microsoft.com',
    'login.live.com'
])
const WELCOME =
    /welcome|getting started|introduction|terms of (?:use|service)|microsoft services agreement|privacy notice|chào mừng|bắt đầu|điều khoản sử dụng|thông báo quyền riêng tư/i
const SENSITIVE =
    /password|passkey|verification code|security code|two.factor|authenticator|purchase|payment|credit card|subscription|buy now|delete (?:account|files?)|grant.{0,30}(?:access|permission)|permissions? requested|application permissions|wants? (?:to )?(?:access|read)|access your (?:profile|files|contacts|mail|data)|mật khẩu|mã xác minh|mã bảo mật|thanh toán|mua ngay|cấp quyền|quyền truy cập|truy cập (?:hồ sơ|tệp|danh bạ|thư|dữ liệu)/i
const BUTTON =
    /^(?:get started|continue|next|accept|i agree|agree|okay|ok|got it|done|skip|not now|maybe later|bắt đầu|tiếp tục|tiếp theo|chấp nhận|tôi đồng ý|đồng ý|đã hiểu|để sau|bỏ qua)$/i

// Only first-party, recognizable welcome panels are advanced. Unknown prompts,
// authentication challenges and permission/payment decisions are left alone.
export async function advanceMicrosoftWelcome(page: Page, wholePage = false): Promise<number> {
    let url: URL
    try {
        url = new URL(page.url())
    } catch {
        return 0
    }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) return 0
    let handled = 0
    for (let step = 0; step < 5; step++) {
        if (page.isClosed()) break
        const panels = page.getByRole('dialog').or(page.getByRole('alertdialog'))
        let panel = panels.first()
        if (!(await panel.isVisible().catch(() => false))) {
            if (!wholePage || !['account.microsoft.com', 'privacynotice.account.microsoft.com'].includes(url.hostname))
                break
            panel = page.locator('body')
        }
        const text = await panel.innerText({ timeout: 1500 }).catch(() => '')
        if (!WELCOME.test(text) || SENSITIVE.test(text)) break
        const button = panel
            .getByRole('button', { name: BUTTON })
            .or(panel.getByRole('link', { name: BUTTON }))
            .first()
        if (!(await button.isVisible().catch(() => false)) || !(await button.isEnabled().catch(() => false))) break
        await button.click({ timeout: 5000 })
        handled++
        await page.waitForTimeout(350)
        try {
            url = new URL(page.url())
        } catch {
            break
        }
        if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) break
    }
    return handled
}
