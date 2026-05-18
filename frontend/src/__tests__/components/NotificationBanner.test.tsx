import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NotificationBanner } from '../../components/NotificationBanner'
import { NotificationProvider, useNotification } from '../../context/NotificationContext'

// Wrapper that provides the context and a trigger button for seeding notifications.
function Harness({ type, message }: { type: 'success' | 'error'; message: string }) {
  const { notify } = useNotification()
  return (
    <>
      <button onClick={() => notify(type, message)}>trigger</button>
      <NotificationBanner />
    </>
  )
}

function renderBanner(type: 'success' | 'error' = 'success', message = 'Test message') {
  return render(
    <NotificationProvider>
      <Harness type={type} message={message} />
    </NotificationProvider>,
  )
}

describe('NotificationBanner', () => {
  test('renders nothing when there are no notifications', () => {
    render(
      <NotificationProvider>
        <NotificationBanner />
      </NotificationProvider>,
    )
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument()
  })

  test('shows a success notification after notify is called', () => {
    renderBanner('success', 'Upload complete')
    fireEvent.click(screen.getByText('trigger'))
    expect(screen.getByText('Upload complete')).toBeInTheDocument()
  })

  test('shows an error notification after notify is called', () => {
    renderBanner('error', 'Something went wrong')
    fireEvent.click(screen.getByText('trigger'))
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  test('success notification uses green styling', () => {
    renderBanner('success', 'Done')
    fireEvent.click(screen.getByText('trigger'))
    const banner = screen.getByText('Done').closest('div[class]')!
    expect(banner.className).toContain('green')
  })

  test('error notification uses red styling', () => {
    renderBanner('error', 'Failed')
    fireEvent.click(screen.getByText('trigger'))
    const banner = screen.getByText('Failed').closest('div[class]')!
    expect(banner.className).toContain('red')
  })

  test('dismiss button removes the notification', () => {
    renderBanner('success', 'Bye')
    fireEvent.click(screen.getByText('trigger'))
    expect(screen.getByText('Bye')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('Bye')).not.toBeInTheDocument()
  })
})
