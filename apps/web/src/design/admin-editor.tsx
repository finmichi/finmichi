// SPDX-License-Identifier: AGPL-3.0-only
import { Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { EdgeScroll } from './edge-scroll';
export function AdminEditor({
  opened,
  title,
  onClose,
  busy,
  children,
  desktopSize = 440,
}: {
  opened: boolean;
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
  desktopSize?: number;
}) {
  const phone = useMediaQuery('(max-width: 899px)');
  return (
    <Drawer
      opened={opened}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      position="right"
      size={phone ? '100%' : desktopSize}
      title={title}
      closeButtonProps={{ 'aria-label': '關閉編輯', size: 44 }}
      classNames={{ content: 'admin-editor', body: 'admin-editor-body' }}
    >
      <EdgeScroll label="管理編輯內容">{children}</EdgeScroll>
    </Drawer>
  );
}
