import { render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PdfViewer } from '../../components/PdfViewer'

// Isolate PdfViewer from `import.meta.url` (Vite-only ESM syntax Jest's
// CommonJS transform can't parse) — see src/utils/pdfWorker.ts.
jest.mock('../../utils/pdfWorker', () => ({ pdfWorkerUrl: () => 'test://pdf-worker' }))

// Configurable pdf.js mock: `docConfig` controls page count and which page's
// render() rejects. jsdom has no IntersectionObserver, so PdfViewer takes its
// eager render-every-page path here.
const docConfig: { numPages: number; failPage: number | null; docThrows: boolean } = {
  numPages: 1,
  failPage: null,
  docThrows: false,
}

jest.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: docConfig.docThrows
      ? Promise.reject(new Error('bad document'))
      : Promise.resolve({
          numPages: docConfig.numPages,
          getPage: (n: number) =>
            Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 130 * scale }),
              render: () => ({
                promise:
                  docConfig.failPage === n
                    ? Promise.reject(new Error('render failed'))
                    : Promise.resolve(),
              }),
            }),
        }),
  }),
}))

beforeEach(() => {
  docConfig.numPages = 1
  docConfig.failPage = null
  docConfig.docThrows = false
})

describe('PdfViewer', () => {
  test('renders a canvas per page', async () => {
    docConfig.numPages = 3
    const onError = jest.fn()
    const { container } = render(<PdfViewer url="/preview" onError={onError} />)
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBe(3))
    expect(onError).not.toHaveBeenCalled()
  })

  test('a later-page render failure is swallowed — the document is not blanked', async () => {
    docConfig.numPages = 3
    docConfig.failPage = 2 // page 2 fails; pages 1 and 3 still render
    const onError = jest.fn()
    const { container } = render(<PdfViewer url="/preview" onError={onError} />)
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBe(2))
    expect(onError).not.toHaveBeenCalled()
  })

  test('a first-page render failure surfaces the error', async () => {
    docConfig.numPages = 3
    docConfig.failPage = 1
    const onError = jest.fn()
    render(<PdfViewer url="/preview" onError={onError} />)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
  })

  test('a document-load failure surfaces the error', async () => {
    docConfig.docThrows = true
    const onError = jest.fn()
    render(<PdfViewer url="/preview" onError={onError} />)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
  })
})
