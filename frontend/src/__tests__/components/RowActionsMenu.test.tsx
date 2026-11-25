import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { RowActionsMenu, MenuRow } from '../../components/RowActionsMenu'

describe('RowActionsMenu / MenuRow', () => {
  test('clicking the label text triggers the row action, not just the icon', () => {
    const onDelete = jest.fn()
    render(
      <RowActionsMenu>
        <MenuRow label="Delete file">
          <button onClick={onDelete}>icon</button>
        </MenuRow>
      </RowActionsMenu>,
    )

    fireEvent.click(screen.getByLabelText('Item actions'))
    fireEvent.click(screen.getByText('Delete file'))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  test('clicking the control itself still only fires once', () => {
    const onDelete = jest.fn()
    render(
      <RowActionsMenu>
        <MenuRow label="Delete file">
          <button onClick={onDelete}>icon</button>
        </MenuRow>
      </RowActionsMenu>,
    )

    fireEvent.click(screen.getByLabelText('Item actions'))
    fireEvent.click(screen.getByText('icon'))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
