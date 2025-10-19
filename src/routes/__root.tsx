import { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext } from "@tanstack/react-router"
import { NotFoundScreen } from "../components/common/NotFoundScreen"

const RooteComponent = () => {
  return (
    <div>Hello world</div>
  )
}

export const Route = createRootRouteWithContext<{queryClient: QueryClient}>()({
  component: RooteComponent,
  notFoundComponent: () => <NotFoundScreen />,
})