import fs from 'node:fs'
import path from 'node:path'

const HEADLESS_SHELL_REQUIRED = [
    'icudtl.dat',
    'headless_lib_data.pak',
    'headless_lib_strings.pak',
    'v8_context_snapshot.bin'
]

const CHROME_FULL_REQUIRED = ['icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin']

function findFilesByName(dir, targets, maxDepth = 4, depth = 0, out = []) {
    if (depth > maxDepth || !fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            findFilesByName(full, targets, maxDepth, depth + 1, out)
        } else if (targets.has(entry.name.toLowerCase())) {
            out.push(full)
        }
    }
    return out
}

export function verifyWindowsBrowserBundle(browsersPath) {
    if (!browsersPath) {
        return { ok: true, checked: 0, directories: [] }
    }
    const resolved = path.resolve(browsersPath)
    if (!fs.existsSync(resolved)) {
        throw new Error(
            `PLAYWRIGHT_BROWSERS_PATH does not exist: ${resolved}. Unpack the complete Chromium bundle including icudtl.dat and *.pak files.`
        )
    }

    const executables = findFilesByName(resolved, new Set(['chrome-headless-shell.exe', 'chrome.exe']))
    if (!executables.length) {
        throw new Error(
            `No Windows Chromium executable (chrome-headless-shell.exe or chrome.exe) found under ${resolved}.`
        )
    }

    const checkedDirs = []
    for (const exe of executables) {
        const exeDir = path.dirname(exe)
        const exeName = path.basename(exe).toLowerCase()
        const required = exeName === 'chrome-headless-shell.exe' ? HEADLESS_SHELL_REQUIRED : CHROME_FULL_REQUIRED
        const missing = required.filter(file => !fs.existsSync(path.join(exeDir, file)))
        if (missing.length) {
            throw new Error(
                `Incomplete Windows Chromium bundle in ${exeDir}: missing [${missing.join(', ')}]. ` +
                    'Never copy only the .exe file (causes ICU crash 2147483651); extract the full archive with tar.exe.'
            )
        }
        checkedDirs.push(exeDir)
    }

    return { ok: true, checked: checkedDirs.length, directories: checkedDirs }
}
