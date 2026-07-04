import {
  STORAGE_PLANS,
  CUSTOM_MIN_BYTES,
  CUSTOM_MAX_BYTES,
  TIB,
  customPriceCents,
  formatCents,
} from '../../api/billing'

describe('storage plans', () => {
  it('mirrors the iOS app pricing exactly', () => {
    const byId = Object.fromEntries(STORAGE_PLANS.map((p) => [p.id, p]))
    expect(byId['64gb'].priceCents).toEqual({ nvme: 3000, hdd: 2000 })
    expect(byId['128gb'].priceCents).toEqual({ nvme: 5000, hdd: 3000 })
    expect(byId['256gb'].priceCents).toEqual({ nvme: 8000, hdd: 5000 })
    expect(byId['512gb'].priceCents).toEqual({ nvme: 15000, hdd: 8000 })
    expect(byId['1tb'].priceCents).toEqual({ nvme: 25000, hdd: 12000 })
  })
})

describe('customPriceCents', () => {
  it('extends the 1 TB plan linearly per TiB', () => {
    expect(customPriceCents(2 * TIB, 'nvme')).toBe(50000)   // $500
    expect(customPriceCents(2 * TIB, 'hdd')).toBe(24000)    // $240
    expect(customPriceCents(1024 * TIB, 'nvme')).toBe(25600000) // 1 PiB → $256k
  })

  it('covers the slider bounds', () => {
    expect(CUSTOM_MIN_BYTES).toBe(TIB)
    expect(CUSTOM_MAX_BYTES).toBe(10 * 1024 * TIB)
    // 10 PiB nvme = $2.56M — still fits a 32-bit cents column.
    expect(customPriceCents(CUSTOM_MAX_BYTES, 'nvme')).toBe(256000000)
  })
})

describe('formatCents', () => {
  it('formats dollars with two decimals', () => {
    expect(formatCents(3000)).toBe('$30.00')
    expect(formatCents(12550)).toBe('$125.50')
  })
})
