import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TermsOfServiceModal } from '../../components/TermsOfServiceModal'

const onClose = jest.fn()

beforeEach(() => jest.clearAllMocks())

describe('TermsOfServiceModal', () => {
  test('renders the Terms of Service heading', () => {
    render(<TermsOfServiceModal onClose={onClose} />)
    expect(screen.getByRole('heading', { name: /terms of service/i })).toBeInTheDocument()
  })

  test('renders key section headings', () => {
    render(<TermsOfServiceModal onClose={onClose} />)
    expect(screen.getByRole('heading', { name: /acceptable use policy/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /suspension and termination/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /disclaimer of warranties/i })).toBeInTheDocument()
  })

  test('footer Close button calls onClose', () => {
    render(<TermsOfServiceModal onClose={onClose} />)
    // The footer has a visible "Close" text button; the header has an aria-label="Close" icon button
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i })
    fireEvent.click(closeButtons[closeButtons.length - 1])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('close icon button calls onClose', () => {
    render(<TermsOfServiceModal onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  test('clicking the backdrop calls onClose', () => {
    const { container } = render(<TermsOfServiceModal onClose={onClose} />)
    fireEvent.click(container.firstChild as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('clicking inside the modal body does not call onClose', () => {
    render(<TermsOfServiceModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('heading', { name: /terms of service/i }))
    expect(onClose).not.toHaveBeenCalled()
  })

  test('Escape key calls onClose', () => {
    render(<TermsOfServiceModal onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
