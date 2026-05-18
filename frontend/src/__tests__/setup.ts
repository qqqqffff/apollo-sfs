// Polyfill crypto.randomUUID for jsdom — jsdom provides crypto but not randomUUID.
// A simple counter-based stub is sufficient for test isolation.
if (!globalThis.crypto.randomUUID) {
  let seq = 0
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `test-uuid-${++seq}`,
  })
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
