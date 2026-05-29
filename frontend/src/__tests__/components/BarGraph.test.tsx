import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { BarGraph } from '../../components/BarGraph'
import type { Bar } from '../../components/BarGraph'

const bars: Bar[] = [
  { label: 'CPU',    value: 50, color: '#f59e0b' },
  { label: 'Memory', value: 75, color: '#8b5cf6', detail: '6 / 8 GB' },
]

describe('BarGraph', () => {
  test('renders an SVG', () => {
    const { container } = render(<BarGraph bars={bars} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  test('renders one rect per bar', () => {
    const { container } = render(<BarGraph bars={bars} />)
    expect(container.querySelectorAll('rect')).toHaveLength(bars.length)
  })

  test('renders a label for each bar', () => {
    const { getByText } = render(<BarGraph bars={bars} />)
    expect(getByText('CPU')).toBeInTheDocument()
    expect(getByText('Memory')).toBeInTheDocument()
  })

  test('renders optional detail text when provided', () => {
    const { getByText } = render(<BarGraph bars={bars} />)
    expect(getByText('6 / 8 GB')).toBeInTheDocument()
  })

  test('renders with custom height', () => {
    const { container } = render(<BarGraph bars={bars} height={300} />)
    expect(container.querySelector('svg')).toHaveAttribute('height', '300')
  })

  test('renders an empty chart without throwing', () => {
    expect(() => render(<BarGraph bars={[]} />)).not.toThrow()
  })

  test('clamps bar value percentage text to valid range', () => {
    const { getByText } = render(
      <BarGraph bars={[{ label: 'X', value: 150, color: '#000' }]} />
    )
    expect(getByText('100.0%')).toBeInTheDocument()
  })
})
