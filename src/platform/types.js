// Shared JSDoc types for the platform adapters (web.js, native.js).

/**
 * @typedef {'saved' | 'shared' | 'cancelled' | 'failed'} SaveStatus
 * @typedef {{ status: SaveStatus, message?: string }} SaveResult
 *
 * @typedef {object} Platform
 * @property {string} name                  'web' | 'android' | 'ios'
 * @property {boolean} isNative             true inside the Capacitor app
 * @property {boolean} canShare             whether the Share button is offered
 * @property {(text: string) => Promise<boolean>} copyText
 * @property {(file: { filename: string, text: string, mimeType: string }) => Promise<SaveResult>} saveFile
 * @property {(options: { title: string, text: string }) => Promise<SaveResult>} shareText
 * @property {(theme: string) => void} setAppearance   'light' | 'dark' — system bar styling
 * @property {(handler: () => boolean) => void} onBack  handler returns true when it consumed the back press
 * @property {() => void} ready             the UI has rendered (e.g. hide the splash screen)
 */

export {};
