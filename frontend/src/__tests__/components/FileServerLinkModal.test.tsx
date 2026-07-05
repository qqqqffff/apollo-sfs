import { detectDeviceOS } from '../../components/FileServerLinkModal'

describe('detectDeviceOS', () => {
  it('detects Windows', () => {
    expect(detectDeviceOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('windows')
  })

  it('detects macOS', () => {
    expect(detectDeviceOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('macos')
  })

  it('detects iOS (iPhone and iPad)', () => {
    expect(detectDeviceOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios')
    expect(detectDeviceOS('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios')
  })

  it('detects Android', () => {
    expect(detectDeviceOS('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36')).toBe('android')
  })

  it('detects Linux', () => {
    expect(detectDeviceOS('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0')).toBe('linux')
  })

  it('defaults to Linux when the device cannot be discerned', () => {
    expect(detectDeviceOS('SomeUnknownAgent/1.0')).toBe('linux')
    expect(detectDeviceOS('')).toBe('linux')
  })
})
