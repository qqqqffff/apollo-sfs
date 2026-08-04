import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NavigationBlockedModal } from '../../components/NavigationBlockedModal'

describe('NavigationBlockedModal', () => {
  test('shows the message and title', () => {
    render(<NavigationBlockedModal message="An upload is still in progress." onLeave={() => {}} onStay={() => {}} />)
    expect(screen.getByText('Leave now?')).toBeInTheDocument()
    expect(screen.getByText('An upload is still in progress.')).toBeInTheDocument()
  })

  test('clicking "Leave anyway" calls onLeave', () => {
    const onLeave = jest.fn()
    render(<NavigationBlockedModal message="x" onLeave={onLeave} onStay={() => {}} />)
    fireEvent.click(screen.getByText('Leave anyway'))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  test('clicking "Stay — let it finish" calls onStay', () => {
    const onStay = jest.fn()
    render(<NavigationBlockedModal message="x" onLeave={() => {}} onStay={onStay} />)
    fireEvent.click(screen.getByText('Stay — let it finish'))
    expect(onStay).toHaveBeenCalledTimes(1)
  })

  test('Escape calls onStay (the safe default)', () => {
    const onStay = jest.fn()
    render(<NavigationBlockedModal message="x" onLeave={() => {}} onStay={onStay} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onStay).toHaveBeenCalledTimes(1)
  })
})
