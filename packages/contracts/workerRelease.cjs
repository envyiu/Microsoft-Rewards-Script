/* eslint-disable @typescript-eslint/no-require-imports -- Shared CommonJS release verification for Node runtime and standalone updater. */
// Release identity is independent of snapshot/configuration revisions.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const versionPattern = /^\d+\.\d+\.\d+$/
function safeName(name) {
    return (
        typeof name === 'string' &&
        name.length > 0 &&
        !name.includes('\\') &&
        !name.includes(':') &&
        !name.includes('\0') &&
        !name.startsWith('/') &&
        name.split('/').every(p => p && p !== '.' && p !== '..')
    )
}
function validateManifest(m) {
    if (
        !m ||
        m.product !== 'msrw-worker' ||
        !versionPattern.test(m.version) ||
        m.protocolVersion !== 3 ||
        !Number.isFinite(Date.parse(m.builtAt)) ||
        !m.files ||
        !Object.keys(m.files).length ||
        !Object.entries(m.files).every(([p, h]) => safeName(p) && /^[a-f0-9]{64}$/.test(h))
    )
        throw Error('INVALID_RELEASE_MANIFEST')
    const { releaseId, ...content } = m
    if (releaseId !== hash(JSON.stringify(content))) throw Error('INVALID_RELEASE_ID')
    return m
}
function verifyDirectory(directory, manifest) {
    validateManifest(manifest)
    for (const [name, expected] of Object.entries(manifest.files)) {
        const file = path.join(directory, name)
        if (!fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== expected)
            throw Error('RELEASE_CONTENT_MISMATCH')
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))
    if (pkg.version !== manifest.version) throw Error('RELEASE_VERSION_MISMATCH')
    return manifest
}
function readRunningRelease(directory) {
    try {
        const manifest = verifyDirectory(directory, JSON.parse(fs.readFileSync(path.join(directory, 'release.json'))))
        let receipt
        try {
            receipt = JSON.parse(fs.readFileSync(path.join(directory, '.install-receipt.json')))
        } catch {}
        return Object.freeze({
            version: manifest.version,
            releaseId: manifest.releaseId,
            builtAt: manifest.builtAt,
            sha256:
                receipt?.releaseId === manifest.releaseId && /^[a-f0-9]{64}$/.test(receipt.sha256)
                    ? receipt.sha256
                    : null,
            verified: true
        })
    } catch {
        return Object.freeze({ version: null, releaseId: null, sha256: null, verified: false })
    }
}
function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = file + '.tmp'
    const fd = fs.openSync(temporary, 'w', 0o600)
    try {
        fs.writeFileSync(fd, JSON.stringify(value))
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.renameSync(temporary, file)
}
// Parse and validate the entire tar before writing. No links, devices, absolute
// paths or traversal. GNU long names are supported, PAX extensions are rejected.
function extractArchive(archive, destination, expected) {
    const packed = fs.readFileSync(archive)
    if (hash(packed) !== expected) throw Error('ARCHIVE_CHECKSUM_MISMATCH')
    const tar = zlib.gunzipSync(packed, { maxOutputLength: 512 * 1024 * 1024 })
    const entries = [],
        seen = new Set()
    let longName = null
    for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512)
        if (header.every(b => b === 0)) break
        const str = (a, b) => header.subarray(a, b).toString().replace(/\0.*$/s, '')
        const size = parseInt(str(124, 136).trim() || '0', 8)
        const checksum = parseInt(str(148, 156).trim(), 8)
        const actual = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0)
        if (checksum !== actual || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
            throw Error('INVALID_ARCHIVE')
        const type = str(156, 157),
            body = tar.subarray(offset + 512, offset + 512 + size)
        offset += 512 + Math.ceil(size / 512) * 512
        if (type === 'L') {
            longName = body.toString().replace(/\0.*$/s, '')
            continue
        }
        let name = longName || (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100)
        longName = null
        while (name.startsWith('./')) name = name.slice(2)
        name = name.replace(/\/$/, '')
        if (!name && type === '5') continue
        if (!safeName(name) || !['', '0', '5'].includes(type) || seen.has(name)) throw Error('UNSAFE_ARCHIVE_ENTRY')
        seen.add(name)
        entries.push({ name, directory: type === '5', body })
    }
    if (!entries.some(e => e.name === 'release.json')) throw Error('INVALID_ARCHIVE')
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const entry of entries) {
        const file = path.join(destination, entry.name)
        if (entry.directory) fs.mkdirSync(file, { recursive: true, mode: 0o700 })
        else {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
            fs.writeFileSync(file, entry.body, { mode: 0o600, flag: 'wx' })
        }
    }
    const manifest = verifyDirectory(destination, JSON.parse(fs.readFileSync(path.join(destination, 'release.json'))))
    atomicJson(path.join(destination, '.install-receipt.json'), { releaseId: manifest.releaseId, sha256: expected })
    return manifest
}
module.exports = {
    hash,
    versionPattern,
    safeName,
    validateManifest,
    verifyDirectory,
    readRunningRelease,
    atomicJson,
    extractArchive
}
