// Polyfill crypto.randomUUID for jsdom — jsdom provides crypto but not randomUUID.
// A simple counter-based stub is sufficient for test isolation.
if (!globalThis.crypto.randomUUID) {
  let seq = 0
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `test-uuid-${++seq}`,
  })
}
