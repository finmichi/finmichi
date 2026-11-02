// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { boundedMcpJson, maskMcpText, MCP_MAX_BYTES } from './mcp.js';
it('caps serialized tool output including JSON escaping and multibyte characters', () => {
  expect(boundedMcpJson({ memo: 'x'.repeat(1000) })).toContain('memo');
  for (const value of [
    'x'.repeat(MCP_MAX_BYTES),
    '漢'.repeat(MCP_MAX_BYTES / 2),
    '"'.repeat(MCP_MAX_BYTES / 2),
  ])
    expect(() => boundedMcpJson(value)).toThrow('output_too_large');
});
it('recursively masks sensitive strings without changing money, item names or null relationships', () => {
  expect(
    maskMcpText({
      items: [
        {
          memo: 'secret',
          invoice_no: 'secret',
          payee_name: 'secret',
          project_name: 'secret',
          item_name: 'Cash',
          amount: '100',
          payee_id: null,
        },
      ],
    }),
  ).toEqual({
    items: [
      {
        memo: '[masked]',
        invoice_no: '[masked]',
        payee_name: '[masked]',
        project_name: '[masked]',
        item_name: 'Cash',
        amount: '100',
        payee_id: null,
      },
    ],
  });
});
