// Chromium must use the display protocol supplied by the desktop session.
// A systemd user service may discover only Wayland after starting at boot.
export function manualDisplayArgs(environment = process.env, platform = process.platform) {
    if (platform !== 'linux') return []
    if (environment.DISPLAY) return ['--ozone-platform=x11']
    if (environment.WAYLAND_DISPLAY) return ['--ozone-platform=wayland']
    return []
}
