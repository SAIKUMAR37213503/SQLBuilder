// Browser implementation of the platform interface. This is the behaviour the
// web app has always had; the Android app swaps in ./native.js instead.
// See ./types.js for the Platform interface.

/**
 * @param {Document} [doc]
 * @returns {import('./types.js').Platform}
 */
export function createWebPlatform(doc = document) {
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Clipboard API unavailable (insecure context, permissions): legacy fallback
            const area = doc.createElement('textarea');
            area.className = 'visually-hidden';
            area.readOnly = true;
            area.value = text;
            doc.body.appendChild(area);
            area.select();
            try {
                return doc.execCommand('copy');
            } catch {
                return false;
            } finally {
                area.remove();
            }
        }
    }

    /** @returns {Promise<import('./types.js').SaveResult>} */
    async function saveFile({ filename, text, mimeType }) {
        try {
            const blob = new Blob([text], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = doc.createElement('a');
            a.href = url;
            a.download = filename;
            a.className = 'visually-hidden';
            doc.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            return { status: 'saved' };
        } catch (error) {
            return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
        }
    }

    return {
        name: 'web',
        isNative: false,
        canShare: false,
        copyText,
        saveFile,
        shareText: async () => ({ status: 'failed', message: 'Sharing is not available here.' }),
        setAppearance: () => {},
        onBack: () => {},
        ready: () => {}
    };
}
