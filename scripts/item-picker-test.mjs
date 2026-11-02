// SPDX-License-Identifier: AGPL-3.0-only
// Mobile ItemPicker has a category step; legacy suites search the exact expected
// item while dedicated picker acceptance separately exercises both steps.
export async function revealItemOption(page, label) {
  const search = page.getByRole('textbox', {
    name: '搜尋完整科目路徑',
    exact: true,
  });
  if (await search.isVisible()) await search.fill(label);
}
