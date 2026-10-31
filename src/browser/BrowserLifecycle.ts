import type { BrowserContext } from 'patchright'
import type { Logger } from '../logging/Logger'

const closingContexts = new WeakSet<BrowserContext>()

export function markContextClosing(context: BrowserContext): void {
    closingContexts.add(context)
}

export function observeContextClosure(
    context: BrowserContext,
    logger: Pick<Logger, 'debug' | 'warn'>,
    isMobile: boolean
): void {
    context.once('close', () => {
        if (closingContexts.has(context)) {
            logger.debug(isMobile, 'BROWSER', 'Browser context closed during cleanup')
        } else {
            logger.warn(isMobile, 'BROWSER', 'Browser context closed unexpectedly')
        }
    })
}
