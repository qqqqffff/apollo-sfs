import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { AppIcon } from '../../components/AppIcon'

describe('AppIcon', () => {
  test('renders an SVG element', () => {
    const { container } = render(<AppIcon />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  test('defaults to size 28', () => {
    const { container } = render(<AppIcon />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('width', '28')
    expect(svg).toHaveAttribute('height', '28')
  })

  test('respects custom size prop', () => {
    const { container } = render(<AppIcon size={64} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('width', '64')
    expect(svg).toHaveAttribute('height', '64')
  })

  test('forwards className to the SVG', () => {
    const { container } = render(<AppIcon className="my-icon" />)
    expect(container.querySelector('svg')).toHaveClass('my-icon')
  })

  test('is marked aria-hidden so screen readers skip it', () => {
    const { container } = render(<AppIcon />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
