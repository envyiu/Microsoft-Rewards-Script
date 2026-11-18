/* global document */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { runBasicServiceAction, SAMPLE_FILE, SAMPLE_TASK } = require('../../dist/functions/NewAccountServices.js')
const { advanceMicrosoftWelcome } = require('../../dist/browser/MicrosoftWelcome.js')

test('first-party welcome screens advance while permission, payment and unfamiliar prompts stay untouched', async () => {
    const { chromium } = await import('patchright')
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.route('https://onedrive.live.com/**', route =>
            route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' })
        )
        await page.goto('https://onedrive.live.com/fixture')
        await page.setContent(
            '<div role="dialog">Welcome to OneDrive<button onclick="this.parentElement.innerHTML=\'Getting started <button onclick=&quot;this.parentElement.remove()&quot;>Continue</button>\'">Next</button></div>'
        )
        assert.equal(await advanceMicrosoftWelcome(page), 2)
        await page.setContent(
            '<div role="dialog">Welcome. Grant access to your files<button onclick="document.body.dataset.clicked=1">Accept</button></div>'
        )
        assert.equal(await advanceMicrosoftWelcome(page), 0)
        assert.equal(await page.evaluate(() => document.body.dataset.clicked), undefined)
        await page.setContent(
            '<div role="dialog">Welcome. This application wants to access your profile<button onclick="document.body.dataset.clicked=1">Accept</button></div>'
        )
        assert.equal(await advanceMicrosoftWelcome(page), 0)
        await page.setContent(
            '<div role="dialog">Welcome. Add a credit card for a subscription<button onclick="document.body.dataset.clicked=1">Continue</button></div>'
        )
        assert.equal(await advanceMicrosoftWelcome(page), 0)
        await page.setContent(
            '<div role="dialog">A dialog with an unknown purpose<button onclick="document.body.dataset.clicked=1">Accept</button></div>'
        )
        assert.equal(await advanceMicrosoftWelcome(page), 0)
        await page.setContent(
            `<div role="dialog">Welcome to OneDrive<button onclick="this.parentElement.remove()">Get started</button></div><button onclick="document.getElementById('file').click()">Upload</button><input id="file" type="file" hidden onchange="document.getElementById('result').textContent=this.files[0].name"><p id="result"></p>`
        )
        assert.equal((await runBasicServiceAction(page, 'onedrive')).artifact, true)
        assert.equal(await page.getByText(SAMPLE_FILE, { exact: true }).count(), 1)
    } finally {
        await browser.close()
    }
})

test('service actions create one sample file/task, read at most three messages, and return calendar to today', async () => {
    const { chromium } = await import('patchright')
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent(
            `<button onclick="document.getElementById('file').click()">Upload</button><input id="file" type="file" hidden onchange="document.body.dataset.uploads=Number(document.body.dataset.uploads||0)+1;document.getElementById('result').textContent=this.files[0].name"><p id="result"></p>`
        )
        assert.equal((await runBasicServiceAction(page, 'onedrive')).artifact, true)
        assert.equal(await page.getByText(SAMPLE_FILE, { exact: true }).count(), 1)
        await runBasicServiceAction(page, 'onedrive')
        assert.equal(await page.evaluate(() => Number(document.body.dataset.uploads)), 1)
        await page.locator('#result').evaluate(el => (el.textContent = ''))
        await runBasicServiceAction(page, 'onedrive', true)
        assert.equal(
            await page.evaluate(() => Number(document.body.dataset.uploads)),
            1,
            'durable marker survives a hidden/moved file'
        )

        await page.setContent(
            `<div role="alertdialog"><button onclick="this.parentElement.remove()">Next</button></div><input id="new-task" aria-label="Add a task"><button onclick="document.body.dataset.adds=Number(document.body.dataset.adds||0)+1;document.getElementById('tasks').textContent=document.getElementById('new-task').value;document.getElementById('new-task').value=''">Add</button><div id="tasks"></div>`
        )
        await runBasicServiceAction(page, 'todo')
        assert.equal(await page.getByText(SAMPLE_TASK, { exact: true }).count(), 1)
        await runBasicServiceAction(page, 'todo')
        await page.locator('#tasks').evaluate(el => (el.textContent = ''))
        await runBasicServiceAction(page, 'todo', true)
        assert.equal(await page.evaluate(() => Number(document.body.dataset.adds)), 1)

        await page.setContent(
            `<div role="document" hidden></div><div role="listbox">${[1, 2, 3, 4].map(i => `<div role="option" onclick="document.body.dataset.reads=Number(document.body.dataset.reads||0)+1;document.getElementById('body').textContent='Private fixture message'">Message ${i}</div>`).join('')}</div><div role="document" id="body"></div><button onclick="document.body.dataset.sent='true'">Send</button>`
        )
        assert.equal((await runBasicServiceAction(page, 'outlook')).detail, 'messages-read=3')
        assert.equal(await page.evaluate(() => Number(document.body.dataset.reads)), 3)
        assert.equal(await page.evaluate(() => document.body.dataset.sent), undefined)

        await page.setContent(
            `<button onclick="document.body.dataset.today=Number(document.body.dataset.today||0)+1">Today</button><button onclick="document.body.dataset.next='true'">Next week</button><button onclick="document.body.dataset.created='true'">New event</button>`
        )
        await runBasicServiceAction(page, 'calendar')
        assert.equal(await page.evaluate(() => Number(document.body.dataset.today)), 2)
        assert.equal(await page.evaluate(() => document.body.dataset.next), 'true')
        assert.equal(await page.evaluate(() => document.body.dataset.created), undefined)
    } finally {
        await browser.close()
    }
})

test('empty mailboxes require explicit empty state, and unknown apps remain pending', async () => {
    const { chromium } = await import('patchright')
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent('<div role="listbox">Your inbox is empty</div>')
        assert.equal((await runBasicServiceAction(page, 'outlook')).detail, 'messages-read=0')
        await assert.rejects(runBasicServiceAction(page, 'unknown'), /Unknown Microsoft service/)
    } finally {
        await browser.close()
    }
})
