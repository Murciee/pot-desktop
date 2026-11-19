import { isEnabled } from 'tauri-plugin-autostart-api';

// The OS autostart state is queried asynchronously. Reading it once before the
// first render lets the settings page show its switch in the right position
// straight away instead of flipping (and reflowing the row) after mounting.
let cachedAutoStart = null;

export function getCachedAutoStart() {
    return cachedAutoStart;
}

export async function initAutoStart() {
    try {
        cachedAutoStart = await isEnabled();
    } catch {
        cachedAutoStart = null;
    }
}
