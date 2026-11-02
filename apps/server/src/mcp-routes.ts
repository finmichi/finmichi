// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  patService,
  mcpReadService,
  mcpSchemas,
  mcpTools,
  mcpDraftTools,
  MCP_MAX_BYTES,
  consumeMcpRequest,
  DomainError,
} from '@finmichi/core';
const fields =
  '所有金額與匯率均為字串。transaction_amount 是正分錄本位幣合計；selected_net_amount 是所選科目子樹帶號淨額。income-summary 依期間與營業／業外區分；category-statistics 的 rollup_amount 是科目子樹合計，percentage 為 HALF_UP 十位字串或 null；balance-sheet totals 滿足資產減負債等於權益加累積淨收支。book_amount 是本位幣帳面值；original_balances 是各原幣餘額。查詢以 cursor 分頁，limit 最多 100；收支彙總最多 1000 個時段。遮罩開啟時摘要、發票號碼、收付人及專案名稱回 [masked]。income-summary 的 operating_income、non_operating_income、operating_expense、non_operating_expense 分別為營業與業外收入／支出；income_total、expense_total、net_income 為總收支及淨額。balance-sheet 的 assets、liabilities、net_worth、equity、net_income 分別為資產、負債、淨值、權益與累積淨收支；identity_difference 應為 0，is_balanced 應為 true。category-statistics 的 own_amount 為科目本身金額，root_amount 應等於 total_amount，percentage 不適用時為 null；pie_available 與 pie_reason 說明圓餅是否可用。profit-loss 為多期並列科目損益表，期間最多10年，不接受fixed篩選。net-worth-flow 含期初、收入、支出、權益變動與期末恆等式。account-ledger 僅資產／負債子樹，自然方向餘額依幣別累計；limit最多500，next_cursor續頁、carry為本頁末累計，金額不受cursor篩選重算。cash-forecast 使用 accounts、horizon_days（30/60/90/180/366）、threshold，回傳每日預估日終餘額、來源事件及首次低於門檻日期；只計本位幣資產，完全不寫入預估資料。draft scope 包含唯讀權限，另可 draft_transaction 建立待確認草稿、suggest_item 建議最多5個科目、list_drafts 讀本token草稿。草稿不會入帳，只有cookie session人工核准；draft_transaction 非冪等，請勿盲目重送。單筆預設100000本位幣、每帳本50筆pending、14天到期；note亦受文字遮罩保護。';
export function mcpRoutes(
  app: FastifyInstance,
  db: Database,
  publicUrl: string,
  draftLimit?: string,
) {
  const pats = patService(db);
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    bodyLimit: MCP_MAX_BYTES,
    onRequest: async (r, reply) => {
      reply.header('cache-control', 'no-store');
      if (
        r.headers.origin !== undefined &&
        r.headers.origin !== new URL(publicUrl).origin
      )
        return reply.code(403).send({ error: 'origin_denied' });
      const match = /^Bearer (llp_[A-Za-z0-9_-]{43})$/.exec(
        r.headers.authorization ?? '',
      );
      const p = match ? await pats.authenticate(match[1]!) : null;
      if (!p)
        return reply
          .header('www-authenticate', 'Bearer')
          .code(401)
          .send({ error: 'unauthorized' });
      if (!(await consumeMcpRequest(db, p.id)))
        return reply
          .header('retry-after', '60')
          .code(429)
          .send({ error: 'rate_limited' });
      r.mcpPrincipal = p;
    },
    handler: async (r, reply) => {
      // This stateless, JSON-response endpoint has no SSE stream or session to delete.
      if (r.method !== 'POST')
        return reply
          .header('allow', 'POST')
          .code(405)
          .send({ error: 'method_not_allowed' });
      const service = mcpReadService(db, r.mcpPrincipal!, draftLimit);
      const server = new Server(
        { name: 'finmichi', version: '0.0.1' },
        { capabilities: { tools: {}, resources: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...mcpTools,
          ...(r.mcpPrincipal!.scope === 'draft' ? mcpDraftTools : []),
        ].map((name) => ({
          name,
          description:
            name === 'draft_transaction'
              ? 'FinMichi：建立待確認草稿，不能入帳'
              : 'FinMichi 唯讀 ' + name,
          inputSchema: {
            ...z.toJSONSchema(mcpSchemas[name]),
            type: 'object',
          } as Tool['inputSchema'],
          annotations: {
            readOnlyHint: name !== 'draft_transaction',
            destructiveHint: false,
            idempotentHint: name !== 'draft_transaction',
            openWorldHint: false,
          },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          return await service.call(
            request.params.name,
            request.params.arguments ?? {},
          );
        } catch {
          throw new McpError(ErrorCode.InternalError, 'request_failed');
        }
      });
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
          {
            uri: 'finmichi://docs/report-fields',
            name: 'report-fields',
            mimeType: 'text/plain',
          },
        ],
      }));
      server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async () => ({
          resourceTemplates: [
            {
              uriTemplate: 'finmichi://ledgers/{id}/items',
              name: 'items',
              mimeType: 'application/json',
            },
          ],
        }),
      );
      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;
        if (uri === 'finmichi://docs/report-fields')
          return { contents: [{ uri, mimeType: 'text/plain', text: fields }] };
        const match = /^finmichi:\/\/ledgers\/([^/]+)\/items$/.exec(uri);
        try {
          if (!match) throw new DomainError('not_found', 404);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: await service.resourceItems(match[1]!),
              },
            ],
          };
        } catch (e) {
          throw new McpError(
            ErrorCode.InvalidParams,
            e instanceof DomainError ? e.code : 'request_failed',
          );
        }
      });
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      // SDK v1 declares callback optionals differently under exactOptionalPropertyTypes.
      // The concrete transport implements the same runtime protocol; keep app strictness.
      await server.connect(transport as unknown as Transport);
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.hijack();
      reply.raw.once('close', () => {
        void server.close();
      });
      await transport.handleRequest(r.raw, reply.raw, r.body);
    },
  });
}
declare module 'fastify' {
  interface FastifyRequest {
    mcpPrincipal: Awaited<
      ReturnType<ReturnType<typeof patService>['authenticate']>
    >;
  }
}
