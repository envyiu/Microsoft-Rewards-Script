import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { Page } from 'patchright'

interface UnknownPageDiagnosticOptions {
    platform: 'mobile' | 'desktop'
}

const MAX_ERROR_DIAGNOSTICS_PER_PROCESS = 5
let diagnosticCount = 0
let diagnosticSequence = 0
let diagnosticChain: Promise<void> = Promise.resolve()

function redactSensitiveText(input: string): string {
    return input
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
        .replace(/((?:password|passwd|secret|token|cookie|totp|authorization)\s*[:=]\s*)([^\s"'&|]+)/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/|socks5?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[REDACTED]:[REDACTED]@')
}

function redactHtmlDom(html: string): string {
    return redactSensitiveText(
        html
            .replace(/(<input\b[^>]*type=["']password["'][^>]*\bvalue=)(["'])[^"']*\2/gi, '$1$2[REDACTED]$2')
            .replace(/(<input\b[^>]*\bvalue=)(["'])[^"']*\2([^>]*type=["']password["'])/gi, '$1$2[REDACTED]$2$3')
    )
}

function safePathSegment(value: string, fallback: string): string {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)

    return sanitized || fallback
}

function unknownPageOutputDir(rawUrl: string, capturedAt: string, platform: string): string {
    let hostname = 'unknown-host'
    let pathname = 'root'

    try {
        const url = new URL(rawUrl)
        hostname = safePathSegment(url.hostname, hostname)
        pathname = safePathSegment(url.pathname, pathname)
    } catch {
        pathname = safePathSegment(rawUrl, 'unknown-page')
    }

    const urlHash = createHash('sha256').update(rawUrl).digest('hex').slice(0, 12)
    const urlFolder = `${pathname}-${urlHash}`
    const captureFolder = `${capturedAt.replace(/[:.]/g, '-')}-${platform}-${randomUUID().slice(0, 8)}`

    return path.join(
        process.env.API_DIAGNOSTICS_DIR || path.join(process.cwd(), 'diagnostics'),
        'unknown-login-pages',
        hostname,
        urlFolder,
        captureFolder
    )
}

async function captureErrorDiagnosticNow(page: Page, error: Error): Promise<void> {
    if (!page || page.isClosed() || diagnosticCount >= MAX_ERROR_DIAGNOSTICS_PER_PROCESS) {
        return
    }
    diagnosticCount++
    const seq = ++diagnosticSequence
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const folderName = `error-${timestamp}-${seq}-${randomUUID().slice(0, 8)}`
        const outputDir = path.join(
            process.env.API_DIAGNOSTICS_DIR || path.join(process.cwd(), 'diagnostics'),
            folderName
        )

        const errorLog = redactSensitiveText(
            `
Name: ${error.name}
Message: ${error.message}
Timestamp: ${new Date().toISOString()}
---------------------------------------------------
Stack Trace:
${error.stack || 'No stack trace available'}
        `.trim()
        )

        const [htmlResult, screenshotResult] = await Promise.allSettled([
            page.content(),
            page.screenshot({ fullPage: true, type: 'png' })
        ])

        await fs.mkdir(outputDir, { recursive: true })
        const writes: Promise<void>[] = [fs.writeFile(path.join(outputDir, 'error.txt'), errorLog)]
        if (htmlResult.status === 'fulfilled') {
            writes.push(fs.writeFile(path.join(outputDir, 'dump.html'), redactHtmlDom(htmlResult.value)))
        }
        if (screenshotResult.status === 'fulfilled') {
            writes.push(fs.writeFile(path.join(outputDir, 'screenshot.png'), screenshotResult.value))
        }
        await Promise.all(writes)

        console.log(`Diagnostics saved to: ${outputDir}`)
    } catch (err) {
        console.error('Unable to create error diagnostics:', err)
    }
}

export function errorDiagnostic(page: Page, error: Error): Promise<void> {
    if (!page || page.isClosed() || diagnosticCount >= MAX_ERROR_DIAGNOSTICS_PER_PROCESS) {
        return diagnosticChain
    }
    diagnosticChain = diagnosticChain.then(() => captureErrorDiagnosticNow(page, error)).catch(() => {})
    return diagnosticChain
}

export function flushErrorDiagnostics(): Promise<void> {
    return diagnosticChain
}

export async function unknownPageDiagnostic(
    page: Page,
    { platform }: UnknownPageDiagnosticOptions
): Promise<string | null> {
    if (!page || page.isClosed()) return null

    const capturedAt = new Date().toISOString()
    const rawUrl = page.url()
    const outputDir = unknownPageOutputDir(rawUrl, capturedAt, platform)

    try {
        await fs.mkdir(outputDir, { recursive: true })

        const [htmlResult, screenshotResult] = await Promise.allSettled([
            page.content(),
            page.screenshot({ fullPage: true, type: 'png' })
        ])

        const metadata = {
            url: redactSensitiveText(rawUrl),
            capturedAt,
            platform,
            htmlCaptured: htmlResult.status === 'fulfilled',
            screenshotCaptured: screenshotResult.status === 'fulfilled',
            errors: [
                htmlResult.status === 'rejected'
                    ? `HTML: ${htmlResult.reason instanceof Error ? htmlResult.reason.message : String(htmlResult.reason)}`
                    : null,
                screenshotResult.status === 'rejected'
                    ? `Screenshot: ${screenshotResult.reason instanceof Error ? screenshotResult.reason.message : String(screenshotResult.reason)}`
                    : null
            ].filter((error): error is string => error !== null)
        }

        const writes: Promise<void>[] = [
            fs.writeFile(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
        ]

        if (htmlResult.status === 'fulfilled') {
            writes.push(fs.writeFile(path.join(outputDir, 'page.html'), redactHtmlDom(htmlResult.value)))
        }
        if (screenshotResult.status === 'fulfilled') {
            writes.push(fs.writeFile(path.join(outputDir, 'screenshot.png'), screenshotResult.value))
        }

        await Promise.all(writes)
        console.log(`Unknown login page diagnostics saved to: ${outputDir}`)
        return outputDir
    } catch (error) {
        console.error('Unable to create unknown login page diagnostics:', error)
        return null
    }
}
