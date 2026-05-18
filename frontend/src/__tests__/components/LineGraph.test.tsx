import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'

const twoPoints: LinePoint[] = [
  { x: 1_000_000, y: 100 },
  { x: 2_000_000, y: 200 },
]

const threePoints: LinePoint[] = [
  { x: 1_000_000, y: 0 },
  { x: 2_000_000, y: 500 },
  { x: 3_000_000, y: 250 },
]

describe('LineGraph', () => {
  test('shows waiting message with no points', () => {
    render(<LineGraph points={[]} />)
    expect(screen.getByText(/waiting for data/i)).toBeInTheDocument()
  })

  test('shows waiting message with only one point', () => {
    render(<LineGraph points={[twoPoints[0]]} />)
    expect(screen.getByText(/waiting for data/i)).toBeInTheDocument()
  })

  test('renders an SVG with two or more points', () => {
    const { container } = render(<LineGraph points={twoPoints} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  test('SVG uses supplied width and height', () => {
    const { container } = render(<LineGraph points={twoPoints} width={800} height={300} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('800')
    expect(svg.getAttribute('height')).toBe('300')
  })

  test('default width and height are applied', () => {
    const { container } = render(<LineGraph points={twoPoints} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('640')
    expect(svg.getAttribute('height')).toBe('200')
  })

  test('line path element is rendered', () => {
    const { container } = render(<LineGraph points={twoPoints} />)
    const paths = container.querySelectorAll('path')
    expect(paths.length).toBeGreaterThanOrEqual(2)
  })

  test('renders five y-axis labels by default', () => {
    const formatY = jest.fn((v: number) => `y${v}`)
    render(<LineGraph points={threePoints} formatY={formatY} />)
    expect(formatY).toHaveBeenCalledTimes(5)
  })

  test('renders five x-axis labels by default', () => {
    const formatX = jest.fn((ms: number) => `t${ms}`)
    render(<LineGraph points={threePoints} formatX={formatX} />)
    expect(formatX).toHaveBeenCalledTimes(5)
  })

  test('uses custom formatY output as SVG text', () => {
    const { container } = render(
      <LineGraph points={twoPoints} formatY={() => 'CUSTOM_Y'} />,
    )
    const texts = Array.from(container.querySelectorAll('text')).map((t) => t.textContent)
    expect(texts.some((t) => t === 'CUSTOM_Y')).toBe(true)
  })

  test('uses custom formatX output as SVG text', () => {
    const { container } = render(
      <LineGraph points={twoPoints} formatX={() => 'CUSTOM_X'} />,
    )
    const texts = Array.from(container.querySelectorAll('text')).map((t) => t.textContent)
    expect(texts.some((t) => t === 'CUSTOM_X')).toBe(true)
  })

  test('applies custom color to the line path', () => {
    const { container } = render(<LineGraph points={twoPoints} color="#ff0000" />)
    const paths = Array.from(container.querySelectorAll('path'))
    const linePath = paths.find((p) => p.getAttribute('stroke') === '#ff0000')
    expect(linePath).toBeTruthy()
  })

  test('default formatY renders bytes label', () => {
    const { container } = render(<LineGraph points={twoPoints} />)
    const texts = Array.from(container.querySelectorAll('text')).map((t) => t.textContent)
    expect(texts.some((t) => t?.includes('B'))).toBe(true)
  })

  test('renders gradient fill definition in defs', () => {
    const { container } = render(<LineGraph points={twoPoints} />)
    expect(container.querySelector('defs linearGradient')).toBeInTheDocument()
  })
})
