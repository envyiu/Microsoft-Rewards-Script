import type { AccountProxy } from '../src/interface/Account'

export interface BrowserProxySettings {
    server: string
    bypass: string
    username?: string
    password?: string
}

export interface ProxyRelay {
    url: string
    close(): Promise<void>
}

export function createProxyRelay(proxyConfig: AccountProxy): Promise<ProxyRelay | null>
export function createBrowserProxyConfig(
    proxyConfig: AccountProxy | null | undefined,
    bypass?: string
): Promise<{ proxy: BrowserProxySettings | undefined; close(): Promise<void> }>
