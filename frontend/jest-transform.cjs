// Custom Jest transformer: replaces import.meta.env with ({}) before ts-jest
// compiles the source. ts-jest with module:CommonJS emits import.meta as-is,
// which Node.js rejects in CommonJS mode with a SyntaxError.
const { TsJestTransformer } = require('ts-jest')

const transformer = new TsJestTransformer({
  tsconfig: 'tsconfig.jest.json',
  diagnostics: false,
})

module.exports = {
  process(sourceText, sourcePath, options) {
    const patched = sourceText.replace(/\bimport\.meta\.env\b/g, '({})')
    return transformer.process(patched, sourcePath, options)
  },
  getCacheKey(sourceText, sourcePath, options) {
    const patched = sourceText.replace(/\bimport\.meta\.env\b/g, '({})')
    return transformer.getCacheKey
      ? transformer.getCacheKey(patched, sourcePath, options)
      : patched + sourcePath
  },
}
