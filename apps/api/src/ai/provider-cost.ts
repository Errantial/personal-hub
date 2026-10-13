// Preserve decimal source lexemes before binary float rounding. This conversion
// rounds up to microdollars; it does not establish invoice/billing authority.
export function providerDollarsToMicros(source: string) {
  if (source.length > 100) throw new Error('Invalid cost');
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new Error('Invalid cost');
  const fraction = match[2] ?? '',
    exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
    throw new Error('Invalid cost');
  const digits = BigInt(match[1]! + fraction),
    power = exponent - fraction.length + 6;
  const value =
    power >= 0
      ? digits * 10n ** BigInt(power)
      : (digits + 10n ** BigInt(-power) - 1n) / 10n ** BigInt(-power);
  if (value > 1000000000000n) throw new Error('Invalid cost');
  return Number(value);
}
