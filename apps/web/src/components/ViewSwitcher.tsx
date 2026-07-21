import { VIEWS, type ViewId } from '../lib/views'

interface ViewSwitcherProps {
  active: ViewId
  onChange: (id: ViewId) => void
}

export default function ViewSwitcher({ active, onChange }: ViewSwitcherProps) {
  return (
    <div className="seg" role="group" aria-label="Map view">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          aria-pressed={v.id === active}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}
