import { Link } from '@tanstack/react-router'

export const NotFoundScreen = () => {
  return (
    <div>
      <span>This was unexpected</span>
      <Link to=".">Go Home</Link>
    </div>
  )
}