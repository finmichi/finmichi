// SPDX-License-Identifier: AGPL-3.0-only
import { Brand } from './brand';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Button, Menu, Select, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconHome,
  IconListDetails,
  IconChartBar,
  IconSettings,
  IconPlus,
  IconChevronLeft,
} from '@tabler/icons-react';
import { EdgeScroll } from './edge-scroll';
import { navigate, useLocation, openEntry, focusQuerySearch } from './location';
import { routeTitle } from './routes';
import { useWorkspace } from './workspace';
const ReminderBell = lazy(() =>
  import('../reminders').then((m) => ({ default: m.ReminderBell })),
);
const links = [
  ['/', '總覽', IconHome],
  ['/transactions', '明細', IconListDetails],
  ['/reports/balance-sheet', '報表', IconChartBar],
  ['/investments', '投資', IconChartBar],
  ['/admin', '管理中心', IconSettings],
] as const;
export function LedgerAppShell({
  children,
  preference,
  onTheme,
  subject,
  onLogout,
}: {
  children: ReactNode;
  preference: string;
  onTheme: (v: 'system' | 'light' | 'dark') => void;
  subject: string;
  onLogout: () => void;
}) {
  const location = useLocation(),
    path = location.split('?')[0]!;
  const desktop = useMediaQuery('(min-width: 900px)', false, {
    getInitialValueInEffect: false,
  });
  const { ledgers, selected, select, current } = useWorkspace();
  function entry() {
    openEntry();
  }
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"]',
        ) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        entry();
      }
      if (e.key === '/') {
        e.preventDefault();
        focusQuerySearch();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (desktop && path === '/admin') navigate('/admin/items', true);
  }, [desktop, path]);
  const active = (href: string) =>
    href === '/'
      ? path === '/'
      : href.startsWith('/reports')
        ? path.startsWith('/reports/')
        : href === '/admin'
          ? path.startsWith('/admin')
          : href === '/investments'
            ? path.startsWith('/investments')
            : path === href;
  const selector = (
    <Select
      label="目前帳本"
      placeholder="請先新增帳本"
      value={selected}
      onChange={select}
      data={ledgers.map((l) => ({
        value: l.id,
        label: l.name + ' (' + l.base_currency + ')',
      }))}
      searchable
      allowDeselect={false}
    />
  );
  const nav = (phone: boolean) => (
    <nav
      aria-label={phone ? '手機主導覽' : '主導覽'}
      className={phone ? 'bottom-nav' : 'primary-nav'}
    >
      {links.map(([href, label, Icon], i) => (
        <span className="nav-slot" key={href}>
          {!phone && href === '/admin' && (
            <span className="nav-caption">管理</span>
          )}
          {phone && i === 2 && (
            <button
              type="button"
              className="entry-fab"
              aria-label="記一筆"
              onClick={entry}
            >
              <IconPlus size={24} stroke={2} />
            </button>
          )}
          <a
            href={href}
            onClick={(e) => {
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
                e.preventDefault();
                navigate(href);
              }
            }}
            aria-current={active(href) ? 'page' : undefined}
          >
            <Icon size={phone ? 20 : 16} stroke={2} />
            <span>{phone && label === '管理中心' ? '管理' : label}</span>
          </a>
        </span>
      ))}
    </nav>
  );
  return (
    <div className="ledger-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document
            .querySelector<HTMLElement>('.main-scroll .edge-viewport')
            ?.focus();
        }}
      >
        跳至主要內容
      </a>
      {desktop && (
        <aside className="sidebar">
          <Brand reversed />
          {selector}
          <Button
            type="button"
            variant="filled"
            fullWidth
            className="primary-action"
            aria-label="記一筆"
            onClick={entry}
          >
            ＋ 記一筆
          </Button>
          <Text className="nav-caption">日常</Text>
          {nav(false)}
          <div className="sidebar-foot">
            <span>已登入 · {subject}</span>
            <span>關帳日：{current?.locked_until ?? '未關帳'}</span>
            <button type="button" onClick={onLogout}>
              登出
            </button>
          </div>
        </aside>
      )}
      <main id="main-content" className="shell-main">
        <header className="topbar">
          {!desktop && <Brand markOnly />}
          <div className="topbar-heading">
            {!desktop && path.startsWith('/admin/') ? (
              <button
                type="button"
                className="back-button"
                aria-label="返回管理中心"
                onClick={() => navigate('/admin')}
              >
                <IconChevronLeft size={16} />
                返回
              </button>
            ) : null}
            <h1 className="topbar-title">{routeTitle(path)}</h1>
          </div>
          {desktop ? (
            <span className="ledger-tag">
              {current?.name ?? '尚無帳本'} · {current?.base_currency ?? '—'}
            </span>
          ) : (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <button
                  type="button"
                  className="phone-ledger-label"
                  aria-label="切換帳本"
                  title={current?.name ?? '尚無帳本'}
                >
                  <span>{current?.name ?? '尚無帳本'}</span>
                  <span aria-hidden="true">⌄</span>
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>切換帳本</Menu.Label>
                {ledgers.map((l) => (
                  <Menu.Item
                    key={l.id}
                    onClick={() => select(l.id)}
                    aria-current={l.id === selected ? 'true' : undefined}
                  >
                    {l.name} · {l.base_currency}
                    {l.id === selected ? ' ✓' : ''}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
          <Suspense
            fallback={<span className="reminder-bell" aria-label="載入提醒" />}
          >
            <ReminderBell ledger={current?.id} />
          </Suspense>
          <select
            aria-label="主題"
            value={preference}
            onChange={(e) =>
              onTheme(e.currentTarget.value as 'system' | 'light' | 'dark')
            }
          >
            <option value="system">系統</option>
            <option value="light">淺色</option>
            <option value="dark">深色</option>
          </select>
        </header>
        <EdgeScroll label="主內容" className="main-scroll">
          {children}
        </EdgeScroll>
        {!desktop && nav(true)}
      </main>
    </div>
  );
}
