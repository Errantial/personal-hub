// Reject duplicate object keys before decoding bounded provider responses.
export function parseUniqueJSON(text: string): unknown {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  let position = 0;
  function value(depth: number): void {
    if (depth > 32) throw new Error('Invalid response');
    const start = tokens[position++];
    if (start === '{') {
      const seen = new Set<string>();
      if (tokens[position] === '}') {
        position++;
        return;
      }
      for (;;) {
        const key = JSON.parse(tokens[position++] ?? '') as unknown;
        if (
          typeof key !== 'string' ||
          seen.has(key) ||
          tokens[position++] !== ':'
        )
          throw new Error('Invalid response');
        seen.add(key);
        value(depth + 1);
        const end = tokens[position++];
        if (end === '}') break;
        if (end !== ',') throw new Error('Invalid response');
      }
    } else if (start === '[') {
      if (tokens[position] === ']') {
        position++;
        return;
      }
      for (;;) {
        value(depth + 1);
        const end = tokens[position++];
        if (end === ']') break;
        if (end !== ',') throw new Error('Invalid response');
      }
    } else JSON.parse(start ?? '');
  }
  value(0);
  if (position !== tokens.length) throw new Error('Invalid response');
  return JSON.parse(text);
}
