// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { Button, Paper, Stack, Text, TextInput } from '@mantine/core';
import type { Item } from '@finmichi/core/catalog-schemas';
export interface DraftEntry {
  item_id: string;
  amount: string;
  exchange_rate: string;
}
export const emptyEntry = (): DraftEntry => ({
  item_id: '',
  amount: '',
  exchange_rate: '',
});
export function AdvancedEntries({
  entries,
  onChange,
  items,
  baseCurrency,
  rates,
  disabled,
  onCreateItem,
  lockedItems = false,
}: {
  entries: DraftEntry[];
  onChange: (entries: DraftEntry[]) => void;
  items: Item[];
  baseCurrency: string;
  rates: Record<string, string>;
  disabled: boolean;
  onCreateItem: (index: number) => void;
  lockedItems?: boolean;
}) {
  function change(index: number, patch: Partial<DraftEntry>) {
    onChange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }
  return (
    <Stack>
      <Text>
        每筆分錄填原幣金額：來源／貸方為負，目的／借方為正。至少兩筆，最多 100
        筆；本位幣合計由系統試算平衡。
      </Text>
      {entries.map((entry, index) => {
        const item = items.find((i) => i.id === entry.item_id);
        return (
          <Paper key={index} withBorder p="sm">
            <Stack gap="xs">
              <Text fw={600}>分錄 {index + 1}</Text>
              <ItemPicker
                items={items}
                label={`分錄 ${index + 1} 科目`}
                onCreate={() => onCreateItem(index)}
                data={items
                  .filter((i) => !i.archived || i.id === entry.item_id)
                  .map((i) => ({
                    value: i.id,
                    label: `${i.name} (${i.currency})${i.archived ? '（已封存）' : ''}`,
                  }))}
                value={entry.item_id || null}
                onChange={(id) =>
                  change(index, { item_id: id ?? '', exchange_rate: '' })
                }
                disabled={disabled || lockedItems}
                required
              />
              <TextInput
                label={`分錄 ${index + 1} 金額`}
                description={
                  item ? `原幣 ${item.currency}，保留正負號` : '請先選擇科目'
                }
                inputMode="decimal"
                value={entry.amount}
                onChange={(e) =>
                  change(index, { amount: e.currentTarget.value })
                }
                disabled={disabled}
                required
              />
              {item && item.currency !== baseCurrency ? (
                <TextInput
                  label={`分錄 ${index + 1} 匯率`}
                  description={
                    rates[item.currency]
                      ? `當日參考：${rates[item.currency]}；可手改，清空恢復參考值。`
                      : '無當日參考匯率；B/D 請手填。C 由本位幣實際金額決定有效匯率。'
                  }
                  value={entry.exchange_rate || rates[item.currency] || ''}
                  inputMode="decimal"
                  onChange={(e) =>
                    change(index, { exchange_rate: e.currentTarget.value })
                  }
                  disabled={disabled}
                />
              ) : (
                item && <Text>本位幣匯率：1</Text>
              )}
              <Button
                variant="subtle"
                color="red"
                onClick={() => onChange(entries.filter((_, i) => i !== index))}
                disabled={disabled || lockedItems || entries.length <= 2}
                aria-label={`移除分錄 ${index + 1}`}
              >
                移除此分錄
              </Button>
            </Stack>
          </Paper>
        );
      })}
      <Button
        variant="light"
        onClick={() => onChange([...entries, emptyEntry()])}
        disabled={disabled || lockedItems || entries.length >= 100}
      >
        新增分錄
      </Button>
    </Stack>
  );
}
