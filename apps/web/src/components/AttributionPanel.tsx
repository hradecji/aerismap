import type { Attribution } from '@aerismap/shared'

export default function AttributionPanel({ attribution }: { attribution: Attribution[] }) {
  return (
    <details className="panel sources">
      <summary>Data sources</summary>
      <ul className="sourcesList">
        {attribution.map((a) => (
          <li key={a.label}>
            <a href={a.url} target="_blank" rel="noreferrer">
              {a.label}
            </a>
            {a.license && <span className="sourceLicense"> · {a.license}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}
