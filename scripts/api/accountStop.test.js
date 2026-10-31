import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fixture } from './apiFixture.js'

test('Local Stop enforces permissions and reports an unconfirmed save after forced termination', async t => {
    const denied = await fixture(t, { API_ALLOW_SCHEDULE_WRITE: 'false', ACCOUNT_1_EMAIL: 'denied@example.test' })
    assert.equal((await denied.request('/smart-schedule/accounts/1/stop', 'POST', { jobId: 'job' })).status, 403)
    const local = await fixture(t, { ACCOUNT_1_EMAIL: 'one@example.test' })
    fs.writeFileSync(path.join(local.dir, 'fake.cjs'), "process.on('SIGUSR1',()=>{});setInterval(()=>{},1000)")
    assert.equal((await local.request('/smart-schedule/accounts/1/stop', 'POST', {})).status, 400)
    await local.request('/smart-schedule/urgent', 'POST', { enabled: true })
    const before = (await local.request('/status')).data.smart
    const job = before.running[0]
    assert.ok(job.executionId)
    await new Promise(r => setTimeout(r, 150))
    const result = await local.request('/smart-schedule/accounts/1/stop', 'POST', { jobId: job.executionId })
    assert.equal(result.status, 200)
    assert.equal(result.data.stopped, true)
    assert.equal(result.data.sessionSaved, false)
    const after = (await local.request('/status')).data
    assert.equal(after.smart.running.length, 0)
    assert.equal(after.smart.execution['1'].state, 'idle')
    assert.deepEqual(after.smart.accounts['1'].workerFailures, {})
    assert.equal(after.smart.accounts['1'].platforms.desktop.failures, 0)
    assert.ok(after.smart.sessions[0].stopped)
    assert.equal(after.smart.sessions[0].exit.signal, 'SIGKILL')
})
