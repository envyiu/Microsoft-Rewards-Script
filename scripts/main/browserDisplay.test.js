import assert from 'node:assert/strict'
import test from 'node:test'
import { manualDisplayArgs } from './browserDisplay.js'

test('manual Chromium matches X11, Wayland-only and non-Linux sessions', () => {
    assert.deepEqual(manualDisplayArgs({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' }, 'linux'), ['--ozone-platform=x11'])
    assert.deepEqual(manualDisplayArgs({ WAYLAND_DISPLAY: 'wayland-1' }, 'linux'), ['--ozone-platform=wayland'])
    assert.deepEqual(manualDisplayArgs({}, 'linux'), [])
    assert.deepEqual(manualDisplayArgs({ DISPLAY: ':0' }, 'darwin'), [])
})
