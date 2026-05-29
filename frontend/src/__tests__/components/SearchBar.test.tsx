import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SearchBar } from '../../components/SearchBar'

describe('SearchBar', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('renders an input with the default placeholder', () => {
    render(<SearchBar value="" onChange={() => {}} />)
    expect(screen.getByPlaceholderText('Search files and folders…')).toBeInTheDocument()
  })

  test('respects a custom placeholder', () => {
    render(<SearchBar value="" onChange={() => {}} placeholder="Find something" />)
    expect(screen.getByPlaceholderText('Find something')).toBeInTheDocument()
  })

  test('clear button is hidden when value is empty', () => {
    render(<SearchBar value="" onChange={() => {}} />)
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument()
  })

  test('clear button appears when value is non-empty', () => {
    render(<SearchBar value="hello" onChange={() => {}} />)
    expect(screen.getByLabelText('Clear search')).toBeInTheDocument()
  })

  test('debounces onChange — does not call until timer fires', () => {
    const onChange = jest.fn()
    render(<SearchBar value="" onChange={onChange} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'abc' } })
    expect(onChange).not.toHaveBeenCalled()
    act(() => jest.runAllTimers())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  test('clear button calls onChange with an empty string', () => {
    const onChange = jest.fn()
    render(<SearchBar value="hello" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Clear search'))
    act(() => jest.runAllTimers())
    expect(onChange).toHaveBeenCalledWith('')
  })

  test('syncs local state when value prop changes', () => {
    const { rerender } = render(<SearchBar value="old" onChange={() => {}} />)
    rerender(<SearchBar value="new" onChange={() => {}} />)
    expect(screen.getByRole('searchbox')).toHaveValue('new')
  })
})
