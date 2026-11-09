/**
 * The browser zone used for new items. Some embedded WebViews report a fixed
 * UTC offset (for example `+00:00`) instead of an IANA name; the API validates
 * IANA zones, so fall back to UTC rather than sending an unusable zone.
 */
export function deviceTimeZone() {
  const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return value && !/^[+-]/.test(value) ? value : 'UTC';
}
