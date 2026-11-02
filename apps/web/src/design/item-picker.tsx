// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Combobox,
  ScrollArea,
  Select,
  Stack,
  TextInput,
  useCombobox,
  type SelectProps,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Item } from '@finmichi/core/catalog-schemas';
import {
  itemChoices,
  readRecent,
  writeRecent,
  type ItemChoice,
  type PickerMode,
} from './item-options';
export function ItemPicker({
  items,
  mode = 'posting',
  purpose,
  recentKey,
  data,
  onChange,
  onCreate,
  ...props
}: Omit<SelectProps, 'data' | 'onChange'> & {
  items: Item[];
  mode?: PickerMode;
  purpose?: 'budget';
  recentKey?: string;
  data?: ItemChoice[];
  onChange: (id: string | null) => void;
  onCreate?: () => void;
}) {
  const phone = useMediaQuery('(max-width: 899px)');
  const [root, setRoot] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [revision, refresh] = useState(0),
    [desktopSearch, setDesktopSearch] = useState('');
  const store = useCombobox({
    onDropdownClose: () => {
      store.resetSelectedOption();
      setSearch('');
      setRoot(null);
    },
  });
  const choices = useMemo(
    () => itemChoices(items, mode, props.value, data, purpose === 'budget'),
    [items, mode, props.value, data, purpose],
  );
  const selectedLabel =
    choices.find((c) => c.value === props.value)?.label ?? '';
  useEffect(() => {
    setDesktopSearch(selectedLabel);
  }, [selectedLabel, props.value]);
  const allowed = new Set(
    choices.filter((c) => !c.disabled).map((c) => c.value),
  );
  const ledger = items[0]?.ledger_id ?? '',
    bucket = recentKey ?? String(props.label ?? '科目');
  const recent = useMemo(() => {
    if (mode === 'filter') return [];
    try {
      return readRecent(
        localStorage,
        ledger,
        bucket,
        new Set(choices.filter((c) => !c.disabled).map((c) => c.value)),
      );
    } catch {
      return [];
    }
    // revision refreshes optional local recents after a selection.
  }, [choices, mode, ledger, bucket, revision]);
  function choose(id: string | null) {
    if (id === '__create__') {
      store.closeDropdown();
      onCreate?.();
      return;
    }
    if (id && allowed.has(id)) {
      if (mode === 'posting') {
        try {
          writeRecent(localStorage, ledger, bucket, id, allowed);
        } catch {
          /* storage optional */
        }
        refresh((n) => n + 1);
      }
      onChange(id);
    } else if (!id) onChange(null);
    store.closeDropdown();
  }
  const groups = new Map<string, ItemChoice[]>();
  for (const c of choices) {
    const group = recent.includes(c.value) ? '最近使用' : c.group;
    groups.set(group, [...(groups.get(group) ?? []), c]);
  }
  const sorted = [...groups].sort(([a], [b]) =>
    a === '最近使用'
      ? -1
      : b === '最近使用'
        ? 1
        : a === '已封存'
          ? 1
          : b === '已封存'
            ? -1
            : 0,
  );
  if (!phone)
    return (
      <Select
        allowDeselect={false}
        {...props}
        searchable
        searchValue={desktopSearch}
        onSearchChange={setDesktopSearch}
        onOptionSubmit={(id) =>
          setDesktopSearch(choices.find((c) => c.value === id)?.label ?? '')
        }
        comboboxProps={{ withinPortal: false }}
        data={[
          ...sorted.map(([group, values]) => ({
            group,
            items: [...values]
              .sort((a, b) =>
                group === '最近使用'
                  ? recent.indexOf(a.value) - recent.indexOf(b.value)
                  : 0,
              )
              .map(({ value, label, disabled }) => ({
                value,
                label,
                disabled: !!disabled,
              })),
          })),
          ...(onCreate ? [{ value: '__create__', label: '＋ 就地新增' }] : []),
        ]}
        filter={({ options, search }) =>
          options.flatMap<(typeof options)[number]>((o) => {
            const matches = (v: ItemChoice) =>
              v.value === '__create__' ||
              v.label.toLocaleLowerCase().includes(search.toLocaleLowerCase());
            if ('group' in o) {
              const items = o.items.filter((v) => 'value' in v && matches(v));
              return items.length ? [{ ...o, items }] : [];
            }
            return matches(o) ? [o] : [];
          })
        }
        onChange={choose}
      />
    );
  const visible = choices
    .filter((c) =>
      search
        ? c.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())
        : c.root === root,
    )
    .sort((a, b) =>
      mode === 'filter' && !search
        ? Number(b.parent && b.depth === 0) - Number(a.parent && a.depth === 0)
        : 0,
    );
  const roots = [...new Set(choices.map((c) => c.root))].sort((a, b) =>
    a === '已封存' ? 1 : b === '已封存' ? -1 : 0,
  );
  const selected = choices.find((c) => c.value === props.value);
  return (
    <Combobox
      store={store}
      withinPortal={false}
      onOptionSubmit={(value) => {
        if (value.startsWith('__root__:')) {
          setRoot(value.slice(9));
          store.resetSelectedOption();
        } else choose(value || null);
      }}
    >
      <Combobox.Target>
        <TextInput
          label={props.label}
          description={props.description}
          error={props.error}
          required={!!props.required}
          disabled={!!props.disabled}
          {...(props.name ? { name: props.name } : {})}
          {...(props.id ? { id: props.id } : {})}
          {...(props['aria-label']
            ? { 'aria-label': props['aria-label'] }
            : {})}
          readOnly
          value={selected?.label ?? ''}
          placeholder={props.placeholder ?? '請選擇科目'}
          onClick={() => store.toggleDropdown()}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && store.dropdownOpened) e.stopPropagation();
            if (!store.dropdownOpened && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              store.openDropdown();
            }
          }}
          rightSection={<Combobox.Chevron />}
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Stack gap="xs">
          <Combobox.EventsTarget>
            <TextInput
              aria-label="搜尋完整科目路徑"
              placeholder="搜尋完整科目路徑"
              value={search}
              onChange={(e) => {
                setSearch(e.currentTarget.value);
                store.resetSelectedOption();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  store.closeDropdown();
                }
              }}
            />
          </Combobox.EventsTarget>
          {root && !search && (
            <Button
              variant="subtle"
              onClick={() => {
                setRoot(null);
                store.resetSelectedOption();
              }}
            >
              返回大類別
            </Button>
          )}
          <ScrollArea.Autosize mah={300} type="auto">
            <Combobox.Options>
              {!root && !search ? (
                <>
                  {recent.length > 0 && (
                    <Combobox.Group label="最近使用">
                      {recent
                        .map((id) => choices.find((c) => c.value === id)!)
                        .map((c) => (
                          <Combobox.Option
                            key={c.value}
                            value={c.value}
                            style={{ minHeight: 44 }}
                          >
                            {c.label}
                          </Combobox.Option>
                        ))}
                    </Combobox.Group>
                  )}
                  {roots.map((r) => (
                    <Combobox.Option
                      key={r}
                      value={'__root__:' + r}
                      style={{ minHeight: 44 }}
                    >
                      {r} ›
                    </Combobox.Option>
                  ))}
                </>
              ) : (
                visible.map((c) => (
                  <Combobox.Option
                    key={c.value}
                    value={c.value}
                    disabled={c.disabled}
                    style={{ minHeight: 44 }}
                  >
                    {mode === 'filter' &&
                    purpose !== 'budget' &&
                    c.parent &&
                    !search
                      ? '全部 ' + c.label
                      : c.label}
                  </Combobox.Option>
                ))
              )}
              {(root || search) && !visible.length && (
                <Combobox.Empty>沒有符合的科目</Combobox.Empty>
              )}
              {props.clearable && props.value && (
                <Combobox.Option value="" style={{ minHeight: 44 }}>
                  清除科目篩選
                </Combobox.Option>
              )}
              {onCreate && (
                <Combobox.Option value="__create__" style={{ minHeight: 44 }}>
                  ＋ 就地新增
                </Combobox.Option>
              )}
            </Combobox.Options>
          </ScrollArea.Autosize>
        </Stack>
      </Combobox.Dropdown>
    </Combobox>
  );
}
