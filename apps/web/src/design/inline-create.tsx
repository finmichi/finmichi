// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Paper,
  Select,
  Stack,
  TextInput,
  Title,
  type SelectProps,
} from '@mantine/core';
import type { Item, NamedRecord } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from '../api';
export function InlineSelect({
  data,
  onCreate,
  onChange,
  ...props
}: Omit<SelectProps, 'data' | 'onChange'> & {
  data: { value: string; label: string }[];
  onChange: (value: string | null) => void;
  onCreate: () => void;
}) {
  return (
    <Select
      {...props}
      searchable
      comboboxProps={{ withinPortal: false }}
      data={[...data, { value: '__create__', label: '＋ 就地新增' }]}
      filter={({ options, search }) =>
        options.filter(
          (o) =>
            'value' in o &&
            (o.value === '__create__' ||
              o.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
        )
      }
      onChange={(value) => {
        if (value === '__create__') onCreate();
        else onChange(value);
      }}
    />
  );
}
export function InlineCreate({
  base,
  resource,
  currency,
  items,
  onCreated,
  onCancel,
  onDirty,
  onBusy,
}: {
  base: string;
  resource: 'items' | 'payees' | 'projects';
  currency: string;
  items: Item[];
  onCreated: (value: Item | NamedRecord) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(''),
    [kind, setKind] = useState('expense'),
    [unit, setUnit] = useState(currency),
    [parent, setParent] = useState<string | null>(null);
  const [nonOperating, setNonOperating] = useState(false),
    [fixed, setFixed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.scrollIntoView({ block: 'nearest' });
    nameInput.current?.focus();
  }, []);
  const label =
    resource === 'items' ? '科目' : resource === 'payees' ? '收付人' : '專案';
  function changed() {
    onDirty(true);
  }
  async function create() {
    if (resource === 'items' && !/^[A-Z]{3}$/.test(unit)) {
      setError('幣別必須為3碼大寫英文。');
      return;
    }
    if (!name.trim()) {
      setError('請輸入名稱。');
      return;
    }
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const row = await api<Item | NamedRecord>(base + '/' + resource, 'POST', {
        name: name.trim(),
        ...(resource === 'items'
          ? {
              kind,
              currency: unit,
              parent_id: parent,
              non_operating: nonOperating,
              fixed,
            }
          : {}),
      });
      window.dispatchEvent(new Event('ledger:catalog-changed'));
      onCreated(row);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <Paper withBorder p="sm" className="inline-create">
      <Stack gap="xs">
        <Title order={4}>新增{label}</Title>
        {error && (
          <Alert role="alert" color="red">
            {error}
          </Alert>
        )}
        <TextInput
          ref={nameInput}
          label="新增名稱"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            changed();
          }}
          error={error || undefined}
          disabled={busy}
          maxLength={200}
          data-autofocus
        />
        {resource === 'items' && (
          <>
            <Select
              label="新增科目類型"
              value={kind}
              data={[
                { value: 'asset', label: '資產' },
                { value: 'liability', label: '負債' },
                { value: 'income', label: '收入' },
                { value: 'expense', label: '支出' },
                { value: 'equity', label: '權益' },
              ]}
              onChange={(v) => {
                if (v) {
                  setKind(v);
                  setParent(null);
                  changed();
                }
              }}
              disabled={busy}
              comboboxProps={{ withinPortal: false }}
            />
            <TextInput
              label="新增科目幣別"
              value={unit}
              maxLength={3}
              onChange={(e) => {
                setUnit(e.currentTarget.value.toUpperCase());
                changed();
              }}
              disabled={busy}
            />
            <Select
              label="新增科目父科目"
              clearable
              searchable
              value={parent}
              data={items
                .filter((i) => !i.archived && i.kind === kind)
                .map((i) => ({ value: i.id, label: i.name }))}
              onChange={(v) => {
                setParent(v);
                changed();
              }}
              disabled={busy}
              comboboxProps={{ withinPortal: false }}
            />
            <Checkbox
              label="業外"
              checked={nonOperating}
              onChange={(e) => {
                setNonOperating(e.currentTarget.checked);
                changed();
              }}
              disabled={busy}
            />
            <Checkbox
              label="固定性"
              checked={fixed}
              onChange={(e) => {
                setFixed(e.currentTarget.checked);
                changed();
              }}
              disabled={busy}
            />
          </>
        )}
        <Group>
          <Button onClick={() => void create()} disabled={busy}>
            建立並選取
          </Button>
          <Button variant="default" onClick={onCancel} disabled={busy}>
            取消新增
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
