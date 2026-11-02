// SPDX-License-Identifier: AGPL-3.0-only
/** Outlined Manrope wordmark; decorative children have no duplicate names. */
export function Brand({
  reversed = false,
  markOnly = false,
}: {
  reversed?: boolean;
  markOnly?: boolean;
}) {
  return (
    <span
      className={
        'brand' +
        (reversed ? ' brand-reversed' : '') +
        (markOnly ? ' brand-mark-only' : '')
      }
      role="img"
      aria-label="FinMichi"
    >
      <img
        className="brand-symbol brand-light"
        src="/brand/finmichi-mark.svg"
        alt=""
        width="40"
        height="40"
      />
      <img
        className="brand-symbol brand-dark"
        src="/brand/finmichi-mark-reversed.svg"
        alt=""
        width="40"
        height="40"
      />
      {!markOnly && (
        <>
          <img
            className="brand-wordmark brand-light"
            src="/brand/finmichi-wordmark.svg"
            alt=""
            width="154"
            height="30"
          />
          <img
            className="brand-wordmark brand-dark"
            src="/brand/finmichi-wordmark-reversed.svg"
            alt=""
            width="154"
            height="30"
          />
        </>
      )}
    </span>
  );
}
