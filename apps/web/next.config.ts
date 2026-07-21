import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Plain static site: the Cloudflare Worker serves apps/web/out as assets and
  // answers /api/v1/* itself (aerismap-v2-plan.md §3–4).
  output: 'export',
  // @aerismap/shared exports TypeScript source directly.
  transpilePackages: ['@aerismap/shared'],
  reactStrictMode: true,
}

export default nextConfig
