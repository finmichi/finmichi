// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button } from '@mantine/core';
export function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(
      '.main-scroll > .edge-viewport',
    );
    if (!el) return;
    const update = () => setShow(el.scrollTop > el.clientHeight);
    update();
    el.addEventListener('scroll', update);
    return () => el.removeEventListener('scroll', update);
  }, []);
  return show ? (
    <Button
      className="back-to-top"
      variant="light"
      onClick={() =>
        document.querySelector('.main-scroll > .edge-viewport')?.scrollTo({
          top: 0,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 'instant'
            : 'smooth',
        })
      }
    >
      回到頂端 ↑
    </Button>
  ) : null;
}
