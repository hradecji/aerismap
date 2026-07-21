import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'AerisMap',
  description:
    'Europe-wide air quality and weather stations, EAQI-colored, refreshed hourly.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
