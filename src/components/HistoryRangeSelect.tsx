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
        className="h-(--header-control-height)! rounded-(--header-control-radius) border-(--warm-gray) bg-tab-card text-(length:--header-control-font-size) leading-(--header-control-line-height) [corner-shape:squircle]"
        aria-label="History search range"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        className="rounded-(--header-control-radius) [corner-shape:squircle]"
      >
        <SelectGroup>
          {items.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              label={option.label}
              className="rounded-[9px] text-(length:--header-control-font-size) leading-(--header-control-line-height) [corner-shape:squircle]"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
