// SPDX-License-Identifier: AGPL-3.0-only
export const adminRoutes = [
  ['/admin/ledgers', '帳本與關帳'],
  ['/admin/items', '科目樹'],
  ['/admin/payees', '收付人'],
  ['/admin/projects', '專案'],
  ['/admin/memo-templates', '常用摘要'],
  ['/admin/import', '匯入'],
  ['/admin/backup', '匯出與備份'],
  ['/admin/tokens', 'MCP 存取權杖'],
  ['/admin/audit', '稽核紀錄'],
  ['/admin/system', '系統資訊'],
  ['/admin/recurring', '週期交易'],
  ['/admin/budgets', '預算'],
  ['/admin/cards', '信用卡'],
  ['/admin/loans', '貸款'],
  ['/admin/drafts', 'AI 交易草稿'],
  ['/admin/exchange-rates', '匯率'],
  ['/admin/investment-settings', '投資設定'],
  ['/admin/reminders', '提醒設定'],
] as const;
export const reportRoutes = [
  ['/reports/balance-sheet', '資產負債表'],
  ['/reports/income-summary', '收支彙總'],
  ['/reports/category-statistics', '分類統計'],
  ['/reports/budget-vs-actual', '預算 vs 實際'],
  ['/reports/profit-loss', '損益表'],
  ['/reports/flow', '流量'],
  ['/reports/projects', '專案分析'],
] as const;
export const routeTitle = (path: string) =>
  /^\/investments(?:\/[0-9a-f-]{36})?$/.test(path)
    ? '投資'
    : path === '/'
      ? '總覽'
      : path === '/transactions'
        ? '明細'
        : path === '/admin'
          ? '管理中心'
          : ([...adminRoutes, ...reportRoutes].find(([p]) => p === path)?.[1] ??
            '找不到頁面');
export const isKnownRoute = (path: string) =>
  /^\/investments\/[0-9a-f-]{36}$/.test(path) ||
  [
    '/investments',
    '/',
    '/transactions',
    '/admin',
    ...adminRoutes.map((r) => r[0]),
    ...reportRoutes.map((r) => r[0]),
  ].includes(path);
