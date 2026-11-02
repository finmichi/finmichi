// SPDX-License-Identifier: AGPL-3.0-only
import { Component, useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  Notification,
  Progress,
  Skeleton,
  Stack,
} from '@mantine/core';
export const notify = (message: string) => {
  window.dispatchEvent(new CustomEvent('ledger:notice', { detail: message }));
  window.dispatchEvent(new Event('ledger:catalogs-changed'));
};
export function Toast() {
  const [message, setMessage] = useState(''),
    [serial, setSerial] = useState(0);
  useEffect(() => {
    const receive = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail);
      setSerial((v) => v + 1);
    };
    window.addEventListener('ledger:notice', receive);
    return () => window.removeEventListener('ledger:notice', receive);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 2800);
    return () => clearTimeout(timer);
  }, [message, serial]);
  return message ? (
    <Notification
      className="entry-toast"
      role="status"
      title="完成"
      onClose={() => setMessage('')}
      closeButtonProps={{ 'aria-label': '關閉通知' }}
    >
      {message}
    </Notification>
  ) : null;
}
export function EmptyState({
  title,
  children,
  action,
  headingLevel = 3,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  return (
    <section className="panel empty-state">
      {headingLevel === 2 ? <h2>{title}</h2> : <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </section>
  );
}
export function LoadingState({
  label = '載入中',
  hasData = false,
}: {
  label?: string;
  hasData?: boolean;
}) {
  return (
    <div role="status" aria-label={label}>
      {hasData ? (
        <Progress value={100} animated size="xs" aria-label={label} />
      ) : (
        <Stack>
          <Skeleton height={24} />
          <Skeleton height={90} />
          <Skeleton height={140} />
        </Stack>
      )}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <Alert color="red" role="alert">
      {message}
      {retry && (
        <Button variant="subtle" onClick={retry}>
          重試
        </Button>
      )}
    </Alert>
  );
}
export function ConfirmDialog({
  opened,
  title,
  children,
  confirmLabel,
  cancelLabel = '取消',
  onCancel,
  onConfirm,
  busy = false,
  closeLabel = '關閉確認',
  disabled = false,
}: {
  opened: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  closeLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={title}
      centered
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      closeButtonProps={{ 'aria-label': closeLabel, size: 44 }}
    >
      <div>{children}</div>
      <Group mt="md">
        <Button variant="default" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          color="red"
          loading={busy}
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}

export class PageBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorState
        message="頁面載入失敗，請重試。"
        retry={() => window.location.reload()}
      />
    ) : (
      this.props.children
    );
  }
}
