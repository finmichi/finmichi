// SPDX-License-Identifier: AGPL-3.0-only
import { Select } from '@mantine/core';
import type { NamedRecord } from '@finmichi/core/catalog-schemas';
import { useReport } from './report-hooks';
import { ErrorState } from './design/feedback';
import { projectReportText as t } from './project-report-messages';
export function ProjectFilter({
  ledger,
  value,
  onChange,
  label,
}: {
  ledger: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  label: string;
}) {
  const r = useReport<NamedRecord[]>(
    `/api/ledgers/${ledger}/projects?include_archived=true`,
  );
  return (
    <div>
      {r.error && <ErrorState message={r.error} retry={r.retry} />}
      <Select
        label={label}
        placeholder={t.all}
        searchable
        clearable
        value={value ?? null}
        onChange={(v) => onChange(v ?? undefined)}
        data={(r.data ?? []).map((p) => ({
          value: p.id,
          label: p.name + (p.archived ? t.archivedSuffix : ''),
        }))}
      />
    </div>
  );
}
