// Offline scoring only. This script has no provider transport or credentials.
import { readFile } from 'node:fs/promises';

const corpus = JSON.parse(
  await readFile(
    new URL('../tests/fixtures/mail-broker-evaluation.json', import.meta.url),
    'utf8',
  ),
);
if (process.argv.length !== 3)
  throw new Error(
    'Usage: node scripts/evaluate-mail-broker.mjs <predictions.json>',
  );
const predictions = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!Array.isArray(predictions) || predictions.length !== corpus.cases.length)
  throw new Error('Supply exactly one prediction for every case.');
const remaining = new Map(corpus.cases.map((item) => [item.id, item]));
let tp = 0,
  fp = 0,
  fn = 0;
for (const prediction of predictions) {
  const item = remaining.get(prediction.caseId);
  if (
    !item ||
    !Array.isArray(prediction.selectedKeys) ||
    new Set(prediction.selectedKeys).size !== prediction.selectedKeys.length ||
    prediction.selectedKeys.some((key) => !Object.hasOwn(item.expected, key))
  )
    throw new Error('Invalid, duplicate or foreign case/candidate reference.');
  remaining.delete(prediction.caseId);
  const selected = new Set(prediction.selectedKeys);
  for (const [key, judgment] of Object.entries(item.expected)) {
    if (judgment === 'directly_relevant') {
      if (selected.has(key)) tp++;
      else fn++;
    } else if (selected.has(key)) fp++;
  }
}
const precision = tp + fp ? tp / (tp + fp) : 0;
const recall = tp + fn ? tp / (tp + fn) : 0;
const passed = precision >= 0.9 && recall >= 0.9;
console.log(
  JSON.stringify(
    {
      corpus: corpus.version,
      cases: corpus.cases.length,
      precision,
      recall,
      passed,
      scope:
        'Synthetic retrieval quality only; not private-mail acceptance or authorization.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
