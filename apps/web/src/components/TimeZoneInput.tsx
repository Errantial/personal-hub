import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes } from 'react';

// Chromium 113 and current WebViews support this; fall back to free text.
const zoneNames: string[] =
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];

/** Text field for an IANA timezone with keyboard-searchable suggestions. */
export const TimeZoneInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function TimeZoneInput(props, ref) {
  const list = useId();
  return (
    <>
      <input
        {...props}
        ref={ref}
        list={list}
        maxLength={100}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <datalist id={list}>
        {zoneNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
});
