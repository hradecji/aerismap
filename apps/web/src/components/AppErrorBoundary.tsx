'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface AppErrorBoundaryState {
  failed: boolean
}

/**
 * Last-resort guard: a render crash anywhere below (malformed station data, a
 * map edge case) keeps the familiar header + map shell with a reload prompt
 * instead of unmounting the whole tree to a white screen.
 */
export default class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AerisMap render crashed:', error, info.componentStack)
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="app">
        <header className="header">
          <div className="brand">
            AerisMap
            <span className="brandSub">Europe air quality</span>
          </div>
        </header>
        <div className="mapWrap">
          <div className="statusCardWrap">
            <div className="statusCard" role="alert">
              <strong>Something went wrong</strong>
              <p>The map hit an unexpected error and couldn&apos;t recover.</p>
              <button
                type="button"
                className="retry"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
