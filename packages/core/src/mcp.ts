// SPDX-License-Identifier: AGPL-3.0-only
import { reminderService } from './reminders.js';
import { depositService } from './deposits.js';
import { dividendService } from './dividends.js';
import { securityReports } from './securities-read.js';
import { draftService } from './drafts.js';
import { DEFAULT_DRAFT_LIMIT } from './draft-schemas.js';
import { z } from 'zod';
import type { Database } from '@finmichi/db';
import { DomainError, ledgerService, valid } from './catalog.js';
import { itemService } from './items.js';
import { queryService } from './queries.js';
import { reportService } from './reports.js';
import {
  mcpSchemas,
  allMcpTools,
  mcpDraftTools,
  type McpTool,
} from './mcp-schemas.js';
import type { PersonalAccessToken } from './pat-schemas.js';
export type McpPrincipal = PersonalAccessToken & { user_id: string };
export const MCP_MAX_BYTES = 1024 * 1024;
export function maskMcpText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskMcpText);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        [
          'memo',
          'invoice_no',
          'payee_name',
          'project_name',
          'note',
          'filename',
        ].includes(key) && typeof v === 'string'
          ? '[masked]'
          : maskMcpText(v),
      ]),
    );
  return value;
}
export function boundedMcpJson(value: unknown) {
  const text = JSON.stringify(value);
  // Include the text content wrapper and its escaping in the tool-output budget.
  if (
    Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text }] })) >
    MCP_MAX_BYTES
  )
    throw new DomainError('output_too_large', 400);
  return text;
}
export function mcpReadService(
  db: Database,
  p: McpPrincipal,
  draftLimit = DEFAULT_DRAFT_LIMIT,
) {
  const drafts = draftService(db, draftLimit);
  const ledgers = ledgerService(db),
    items = itemService(db),
    query = queryService(db),
    reports = reportService(db);
  async function allowed(ledger: string) {
    if (p.ledger_ids !== null && !p.ledger_ids.includes(ledger))
      throw new DomainError('not_found', 404);
    await ledgers.get(p.user_id, ledger);
  }
  async function execute(tool: McpTool, input: unknown): Promise<unknown> {
    if (
      mcpDraftTools.includes(tool as (typeof mcpDraftTools)[number]) &&
      p.scope !== 'draft'
    )
      throw new DomainError('insufficient_scope', 403);
    switch (tool) {
      case 'draft_transaction': {
        const { ledger_id, note, ...payload } = valid(
          mcpSchemas.draft_transaction,
          input,
        );
        await allowed(ledger_id);
        return drafts.create(p, ledger_id, payload, note);
      }
      case 'suggest_item': {
        const q = valid(mcpSchemas.suggest_item, input);
        await allowed(q.ledger_id);
        return drafts.suggestItems(p.user_id, q.ledger_id, q.text);
      }
      case 'list_drafts': {
        const { limit, ...q } = valid(mcpSchemas.list_drafts, input);
        return drafts.listForToken(p, {
          ...q,
          ...(limit === undefined ? {} : { limit: String(limit) }),
        });
      }
      case 'list_ledgers': {
        valid(mcpSchemas.list_ledgers, input);
        return (await ledgers.list(p.user_id)).filter(
          (l) => p.ledger_ids === null || p.ledger_ids.includes(l.id),
        );
      }
      case 'list_items': {
        const q = valid(mcpSchemas.list_items, input);
        await allowed(q.ledger_id);
        return items.list(p.user_id, q.ledger_id, {
          include_archived: String(q.include_archived ?? false),
        });
      }
      case 'search_transactions': {
        const { ledger_id, limit, ...q } = valid(
          mcpSchemas.search_transactions,
          input,
        );
        await allowed(ledger_id);
        return query.search(p.user_id, ledger_id, {
          ...q,
          ...(limit === undefined ? {} : { limit: String(limit) }),
        });
      }
      case 'get_balance': {
        const { ledger_id, item_id, ...q } = valid(
          mcpSchemas.get_balance,
          input,
        );
        await allowed(ledger_id);
        const report = await reports.balance(p.user_id, ledger_id, q);
        if (!item_id) return { totals: report.totals };
        const item = report.items.find((i) => i.id === item_id);
        if (!item) throw new DomainError('not_found', 404);
        return { totals: report.totals, item };
      }
      case 'get_report': {
        const { ledger_id, report, ...q } = valid(mcpSchemas.get_report, input);
        await allowed(ledger_id);
        if (report === 'reminders')
          return reminderService(db).list(p.user_id, ledger_id);
        if (report === 'deposits')
          return depositService(db).list(p.user_id, ledger_id, q);
        if (report === 'dividends')
          return dividendService(db).report(p.user_id, ledger_id, q);
        if (report === 'holdings')
          return securityReports(db).holdings(p.user_id, ledger_id, q);
        if (report === 'realized-gains')
          return securityReports(db).realized(p.user_id, ledger_id, q);
        if (report === 'cash-forecast')
          return reports.cashForecast(p.user_id, ledger_id, q);
        if (report === 'profit-loss')
          return reports.profitLoss(p.user_id, ledger_id, q);
        if (report === 'net-worth-flow')
          return reports.netWorthFlow(p.user_id, ledger_id, q);
        if (report === 'account-ledger')
          return reports.accountLedger(p.user_id, ledger_id, q);
        if (report === 'budget-vs-actual')
          return reports.budget(p.user_id, ledger_id, q);
        if (report === 'balance-sheet')
          return reports.balance(p.user_id, ledger_id, q);
        if (report === 'income-summary')
          return reports.income(p.user_id, ledger_id, q);
        return reports.category(p.user_id, ledger_id, q);
      }
    }
  }
  return {
    async call(name: string, input: unknown) {
      const tool = allMcpTools.includes(name as McpTool)
        ? (name as McpTool)
        : null;
      let outcome: 'success' | 'denied' | 'error' = 'success';
      let result: {
        content: { type: 'text'; text: string }[];
        isError?: boolean;
      };
      try {
        if (!tool) throw new DomainError('invalid_input', 400);
        const raw = await execute(tool, input);
        result = {
          content: [
            {
              type: 'text',
              text: boundedMcpJson(p.mask_text ? maskMcpText(raw) : raw),
            },
          ],
        };
      } catch (e) {
        outcome =
          e instanceof DomainError && [403, 404].includes(e.statusCode)
            ? 'denied'
            : 'error';
        const code = e instanceof DomainError ? e.code : 'request_failed';
        result = {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: code,
                ...(code === 'output_too_large'
                  ? { message: '輸出超過 1 MiB，請縮小範圍或使用分頁。' }
                  : {}),
              }),
            },
          ],
        };
      }
      // Exactly one record; no arguments, exception messages or output are persisted.
      await db`INSERT INTO audit_logs(user_id,action,outcome,tool,token_prefix) VALUES (${p.user_id},'mcp.call',${outcome},${tool},${p.token_prefix})`;
      return result;
    },
    async resourceItems(ledger: string) {
      const id = valid(z.uuid(), ledger);
      await allowed(id);
      return boundedMcpJson(
        await items.list(p.user_id, id, { include_archived: 'true' }),
      );
    },
  };
}
export async function consumeMcpRequest(db: Database, id: string) {
  // Atomic rolling fixed window shared by every application process/instance.
  const rows =
    await db`UPDATE personal_access_tokens SET request_count=CASE WHEN request_window_at IS NULL OR request_window_at<=now()-interval '1 minute' THEN 1 ELSE request_count+1 END, request_window_at=CASE WHEN request_window_at IS NULL OR request_window_at<=now()-interval '1 minute' THEN now() ELSE request_window_at END WHERE id=${id} AND (request_window_at IS NULL OR request_window_at<=now()-interval '1 minute' OR request_count<60) RETURNING id`;
  return rows.length > 0;
}
