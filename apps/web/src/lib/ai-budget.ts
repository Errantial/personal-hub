export function parseUsdMicros(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(text))
    throw new Error('Use USD amounts with up to six decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(
    BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')),
  );
  if (amount > 1_000_000_000_000)
    throw new Error('The maximum limit is 1,000,000 USD.');
  return amount;
}
export function formatUsdMicros(value: number | string | null): string {
  if (value === null) return '';
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = String(amount % 1_000_000n)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
