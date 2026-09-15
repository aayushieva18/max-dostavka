import { Button } from "./ui";

type Props = {
  value: number;
  max: number;
  onChange: (value: number) => void;
};

export function QuantityPicker({ value, max, onChange }: Props) {
  return (
    <div className="qty-picker">
      <Button
        type="button"
        variant="secondary"
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}
      >
        −
      </Button>
      <span className="qty-picker-value">{value}</span>
      <Button
        type="button"
        variant="secondary"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </Button>
    </div>
  );
}
