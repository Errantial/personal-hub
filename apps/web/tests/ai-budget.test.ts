import { expect, it } from 'vitest';
import { parseUsdMicros, formatUsdMicros } from '../src/lib/ai-budget';
it('converts USD limits exactly without floating-point rounding or exponent coercion', () => {
  for (const [text, micros] of [
    ['0', 0],
    ['0.000001', 1],
    ['0.123456', 123456],
    ['10.000001', 10000001],
    ['1000000', 1000000000000],
  ] as const) {
    expect(parseUsdMicros(text)).toBe(micros);
    expect(formatUsdMicros(micros)).toBe(text);
  }
  expect(parseUsdMicros(' ')).toBeNull();
  expect(formatUsdMicros(null)).toBe('');
  expect(formatUsdMicros('9007199254740993')).toBe('9007199254.740993');
  for (const text of [
    'NaN',
    'Infinity',
    '1e3',
    '01',
    '-1',
    '1.0000001',
    '1000000.000001',
    '1,000',
    '1.',
  ])
    expect(() => parseUsdMicros(text)).toThrow();
});
