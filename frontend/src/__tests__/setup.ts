// Polyfill crypto.randomUUID for jsdom — jsdom provides crypto but not randomUUID.
// A simple counter-based stub is sufficient for test isolation.
if (!globalThis.crypto.randomUUID) {
  let seq = 0
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `test-uuid-${++seq}`,
  })
}

// Polyfill crypto.subtle for jsdom — also missing, unlike real browsers.
// Node's own webcrypto implementation is a drop-in; used by the Google
// backup flow to hash a downloaded file before checking for duplicates.
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: require('node:crypto').webcrypto.subtle,
  })
}

// Polyfill AbortSignal.timeout — not implemented in the jsdom version bundled
// with jest-environment-jsdom but available in Node 17+ and all modern browsers.
if (!AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('TimeoutError', 'TimeoutError')), ms)
    return controller.signal
  }
}

// Polyfill window.scrollTo — used to reset scroll position on step changes
// (e.g. the register wizard) but not implemented by jsdom.
window.scrollTo = () => {}

// Polyfill ResizeObserver — used by FolderBreadcrumb to react to width changes
// but not implemented by jsdom. A no-op stub is enough; tests don't resize.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// Polyfill URLSearchParams.size — added to the WHATWG spec in 2023 and not yet
// implemented in the jsdom version bundled with jest-environment-jsdom.
if (!('size' in URLSearchParams.prototype)) {
  Object.defineProperty(URLSearchParams.prototype, 'size', {
    get() {
      let n = 0
      for (const _ of this as URLSearchParams) n++ // eslint-disable-line @typescript-eslint/no-unused-vars
      return n
    },
  })
}

// Polyfill Blob.prototype.arrayBuffer — jsdom's Blob shim doesn't implement
// it (unlike real browsers), but the Google backup flow relies on it to hash
// a downloaded file before upload.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}

// Stub a 2D canvas context — jsdom has no real canvas backend without the
// optional `canvas` package. PdfViewer only needs a truthy context object;
// actual page drawing happens inside pdf.js's render(), which tests mock out.
const nativeGetContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
  return (nativeGetContext as any)?.apply(this, args) ?? {}
} as typeof HTMLCanvasElement.prototype.getContext
