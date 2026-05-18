import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SortControls } from '../../components/SortControls'
import type { SortState } from '../../hooks/useSort'

const ascName: SortState = { key: 'name', dir: 'asc' }

describe('SortControls', () => {
  test('renders Name, Date and Size buttons', () => {
    render(<SortControls sort={ascName} onSort={() => {}} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Date')).toBeInTheDocument()
    expect(screen.getByText('Size')).toBeInTheDocument()
  })

  test('active sort key gets the dark background', () => {
    render(<SortControls sort={ascName} onSort={() => {}} />)
    expect(screen.getByText('Name').closest('button')).toHaveClass('bg-gray-900')
  })

  test('inactive sort keys do not get the dark background', () => {
    render(<SortControls sort={ascName} onSort={() => {}} />)
    expect(screen.getByText('Date').closest('button')).not.toHaveClass('bg-gray-900')
    expect(screen.getByText('Size').closest('button')).not.toHaveClass('bg-gray-900')
  })

  test('clicking a button calls onSort with that key', () => {
    const onSort = jest.fn()
    render(<SortControls sort={ascName} onSort={onSort} />)
    fireEvent.click(screen.getByText('Date'))
    expect(onSort).toHaveBeenCalledWith('date')
    fireEvent.click(screen.getByText('Size'))
    expect(onSort).toHaveBeenCalledWith('size')
  })

  test('active button shows a direction arrow', () => {
    render(<SortControls sort={ascName} onSort={() => {}} />)
    const nameBtn = screen.getByText('Name').closest('button')!
    expect(nameBtn.querySelector('svg')).toBeInTheDocument()
  })

  test('inactive buttons do not show a direction arrow', () => {
    render(<SortControls sort={ascName} onSort={() => {}} />)
    const dateBtn = screen.getByText('Date').closest('button')!
    expect(dateBtn.querySelector('svg')).not.toBeInTheDocument()
  })
})
