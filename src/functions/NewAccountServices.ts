import type { Page, Locator } from 'patchright'

export const SAMPLE_FILE = 'MSRW getting started.txt'
export const SAMPLE_TASK = 'MSRW: Explore Microsoft To Do'

async function shown(locator: Locator): Promise<boolean> {
    return locator.isVisible().catch(() => false)
}

export async function runBasicServiceAction(page: Page, service: string, artifactCreated = false): Promise<{ artifact: boolean; detail: string }> {
    if (service === 'onedrive') {
        const existing = page.getByText(SAMPLE_FILE, { exact: true }).first()
        const upload = page.getByRole('button', { name: /^(?:add new|new and upload|create or upload|upload)$/i }).first()
        await upload.waitFor({ state: 'visible', timeout: 15000 })
        if (artifactCreated || await shown(existing)) return { artifact: true, detail: 'sample-file-already-created' }
        const chooser = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null)
        await upload.click({ timeout: 5000 })
        const files = page.getByRole('menuitem', { name: /^(?:files|files upload|upload files)$/i })
            .or(page.getByRole('button', { name: /^(?:files|files upload|upload files)$/i })).first()
        await files.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
        if (await shown(files)) await files.click({ timeout: 5000 })
        const picker = await chooser
        if (!picker) throw new Error('OneDrive file upload control unavailable')
        await picker.setFiles({ name: SAMPLE_FILE, mimeType: 'text/plain', buffer: Buffer.from('Getting started with Microsoft OneDrive.\nPersonal sample file created by MSRW.\n', 'utf8') })
        // A conflict is never resolved by overwriting or keeping a duplicate.
        await existing.waitFor({ state: 'visible', timeout: 20000 })
        return { artifact: true, detail: 'sample-file-created' }
    }
    if (service === 'todo') {
        for (let step = 0; step < 6; step++) {
            const tour = page.getByRole('alertdialog').first()
            if (!await shown(tour)) break
            const next = tour.getByRole('button', { name: /^(?:next|got it|done|close)$/i }).first()
            if (!await shown(next)) break
            await next.click({ timeout: 5000 })
            await page.waitForTimeout(500)
        }
        const tasks = page.getByText(/^tasks$/i).first()
        if (await shown(tasks)) await tasks.click({ timeout: 5000 })
        const input = page.getByRole('textbox', { name: /add a task/i }).or(page.getByPlaceholder(/add a task/i)).first()
        await input.waitFor({ state: 'visible', timeout: 15000 })
        const existing = page.getByText(SAMPLE_TASK, { exact: true }).first()
        if (artifactCreated || await shown(existing)) return { artifact: true, detail: 'sample-task-already-created' }
        await input.fill(SAMPLE_TASK)
        const add = page.getByRole('button', { name: /^add$/i }).first()
        if (await shown(add)) await add.click({ timeout: 5000 })
        else await input.press('Enter')
        await existing.waitFor({ state: 'visible', timeout: 15000 })
        return { artifact: true, detail: 'sample-task-created' }
    }
    if (service === 'outlook') {
        const inbox = page.getByRole('treeitem', { name: /^inbox\b/i }).first()
        if (await shown(inbox)) await inbox.click({ timeout: 5000 })
        const list = page.getByRole('listbox').first()
        await list.waitFor({ state: 'visible', timeout: 15000 })
        const messages = list.getByRole('option')
        await messages.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
        const count = Math.min(3, await messages.count())
        if (!count) {
            const empty = page.getByText(/(?:your inbox is empty|all done for the day|nothing in (?:focused|other)|no (?:messages|mail))/i).first()
            if (!await shown(empty)) throw new Error('Outlook message list is not ready')
        }
        for (let index = 0; index < count; index++) {
            await messages.nth(index).click({ timeout: 5000 })
            const body = page.locator('[role="document"]:visible').first()
            await body.waitFor({ state: 'visible', timeout: 10000 })
            if (!(await body.innerText()).trim()) throw new Error('Outlook message body unavailable')
            await page.waitForTimeout(2000)
        }
        return { artifact: false, detail: `messages-read=${count}` }
    }
    if (service === 'calendar') {
        const today = page.getByRole('button', { name: /^(?:today|go to today)(?:\b|$)/i }).first()
        await today.waitFor({ state: 'visible', timeout: 15000 })
        await today.click({ timeout: 5000 })
        const week = page.getByRole('button', { name: /^(?:week|work week)$/i }).first()
        if (await shown(week)) {
            await week.click({ timeout: 5000 })
            const option = page.getByRole('menuitemradio', { name: /^week$/i }).or(page.getByRole('menuitem', { name: /^week$/i })).first()
            if (await shown(option)) await option.click({ timeout: 5000 })
            else await page.keyboard.press('Escape')
        }
        const next = page.getByRole('button', { name: /^next (?:week|date range|period)$/i }).first()
        if (await shown(next)) {
            await next.click({ timeout: 5000 })
            await today.click({ timeout: 5000 })
        }
        await page.waitForTimeout(2000)
        return { artifact: false, detail: 'calendar-today-viewed' }
    }
    throw new Error('Unknown Microsoft service action')
}
