import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select'

type HistoryRangeOption = {
  label: string
  value: string
}

export function HistoryRangeSelect({
  items,
  value,
  onValueChange,
}: {
  items: HistoryRangeOption[]
  value: string
  onValueChange?: (historyRange: string) => void | Promise<void>
}) {
  function handleValueChange(nextValue: unknown) {
    if (typeof nextValue !== 'string' || !items.some((option) => option.value === nextValue)) return
    if (nextValue === value) return
    void onValueChange?.(nextValue)
  }

  return (
    <Select value={value} items={items} onValueChange={handleValueChange}>
      <SelectTrigger
        data-tabout="history-range"
        className="h-(--header-control-height)! [--capsule-fill:var(--card-bg)] text-(length:--header-control-font-size) leading-(--header-control-line-height)"
        aria-label="History search range"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        className="rounded-[28px] [corner-shape:squircle]"
      >
        <SelectGroup>
          {items.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              label={option.label}
              className="text-(length:--header-control-font-size) leading-(--header-control-line-height)"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
