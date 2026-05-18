export type Layout = "both" | "color" | "depth";

type Props = {
  value: Layout;
  onChange: (next: Layout) => void;
  disabled?: boolean;
};

const OPTIONS: { id: Layout; label: string }[] = [
  { id: "both", label: "Both" },
  { id: "color", label: "Colour" },
  { id: "depth", label: "Depth" },
];

export function LayoutToggle({ value, onChange, disabled = false }: Props) {
  return (
    <div className="layout-toggle" role="tablist" aria-label="View">
      {OPTIONS.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={"layout-toggle__btn" + (active ? " layout-toggle__btn--active" : "")}
            onClick={() => onChange(opt.id)}
            disabled={disabled}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
