import App from '../components/App'
import AppErrorBoundary from '../components/AppErrorBoundary'

export default function Page() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  )
}
