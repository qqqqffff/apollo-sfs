// Isolated in its own module so tests can mock it without Jest's CommonJS
// transform ever having to parse `import.meta.url` — ESM-only syntax that
// Jest's default transform can't handle, even though Vite (production)
// resolves it fine.
export function pdfWorkerUrl(): string {
  return new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
}
