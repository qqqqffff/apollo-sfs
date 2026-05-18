import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DeleteConfirmModal, readSkipDeleteCookie, clearSkipDeleteCookie } from '../../components/DeleteConfirmModal'

const defaults = {
  name: 'document.pdf',
  username: 'alice',
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  clearSkipDeleteCookie()
})

describe('DeleteConfirmModal', () => {
  test('displays the file name', () => {
    render(<DeleteConfirmModal {...defaults} />)
    expect(screen.getByText('"document.pdf"')).toBeInTheDocument()
  })

  test('Cancel button calls onCancel', () => {
    render(<DeleteConfirmModal {...defaults} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(defaults.onCancel).toHaveBeenCalledTimes(1)
    expect(defaults.onConfirm).not.toHaveBeenCalled()
  })

  test('Delete button calls onConfirm', () => {
    render(<DeleteConfirmModal {...defaults} />)
    fireEvent.click(screen.getByText('Delete'))
    expect(defaults.onConfirm).toHaveBeenCalledTimes(1)
  })

  test('clicking the backdrop calls onCancel', () => {
    const { container } = render(<DeleteConfirmModal {...defaults} />)
    fireEvent.click(container.firstChild as Element)
    expect(defaults.onCancel).toHaveBeenCalledTimes(1)
  })

  test('clicking the modal body does not call onCancel', () => {
    render(<DeleteConfirmModal {...defaults} />)
    // The inner card has the heading — clicking it should not propagate to backdrop
    fireEvent.click(screen.getByText('Delete permanently?'))
    expect(defaults.onCancel).not.toHaveBeenCalled()
  })

  test('Escape key calls onCancel', () => {
    render(<DeleteConfirmModal {...defaults} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(defaults.onCancel).toHaveBeenCalledTimes(1)
  })

  test('renders the "don\'t show again" checkbox unchecked by default', () => {
    render(<DeleteConfirmModal {...defaults} />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  test('confirming with checkbox checked sets the skip cookie', () => {
    render(<DeleteConfirmModal {...defaults} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('Delete'))
    expect(readSkipDeleteCookie('alice')).toBe(true)
  })

  test('confirming without checkbox does not set the skip cookie', () => {
    render(<DeleteConfirmModal {...defaults} />)
    fireEvent.click(screen.getByText('Delete'))
    expect(readSkipDeleteCookie('alice')).toBe(false)
  })
})
