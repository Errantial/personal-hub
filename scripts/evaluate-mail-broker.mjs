// Offline scoring only. This script has no provider transport or credentials.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepareEvaluation } from './prepare-mail-broker-evaluation.mjs';
import { prepareJevEvaluation } from './prepare-jev-mail-broker-evaluation.mjs';

const corpusUrl = new URL(
  '../tests/fixtures/mail-broker-evaluation.json',
  import.meta.url,
);
const corpusRaw = await readFile(corpusUrl, 'utf8');
const corpus = JSON.parse(corpusRaw);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const canonical = new Map();
for (const prepared of [
  await prepareEvaluation(),
  await prepareJevEvaluation(),
])
  canonical.set(prepared.adapter, evaluationIdentity(prepared));

function evaluationIdentity(prepared) {
  return {
    adapter: prepared.adapter,
    corpus: prepared.corpus,
    corpusSha256: prepared.corpusSha256,
    model: prepared.model,
    rubric: prepared.rubric,
    bounds: prepared.bounds,
    threshold: prepared.threshold,
    requests: prepared.cases.map(({ caseId, requestSha256 }) => ({
      caseId,
      requestSha256,
    })),
  };
}

export function validateEvaluationReceipt(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
    throw new Error('Evaluation receipt is required.');
  if (artifact.valid !== true)
    throw new Error('Evaluation receipt is incomplete or invalid.');
  const expected = canonical.get(artifact.adapter);
  if (!expected)
    throw new Error('Evaluation receipt uses an unknown broker adapter.');
  const actual = {
    adapter: artifact.adapter,
    corpus: artifact.corpus,
    corpusSha256: artifact.corpusSha256,
    model: artifact.model,
    rubric: artifact.rubric,
    bounds: artifact.bounds,
    threshold: artifact.threshold,
    requests: artifact.requests,
  };
  if (sha256(JSON.stringify(actual)) !== sha256(JSON.stringify(expected)))
    throw new Error(
      'Evaluation receipt does not match the current canonical corpus and adapter requests.',
    );
  return artifact.predictions;
}

export function scorePredictions(predictions) {
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
      new Set(prediction.selectedKeys).size !==
        prediction.selectedKeys.length ||
      prediction.selectedKeys.some((key) => !Object.hasOwn(item.expected, key))
    )
      throw new Error(
        'Invalid, duplicate or foreign case/candidate reference.',
      );
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
  return {
    corpus: corpus.version,
    corpusSha256: sha256(corpusRaw),
    cases: corpus.cases.length,
    precision,
    recall,
    passed: precision >= 0.9 && recall >= 0.9,
    scope:
      'Synthetic retrieval quality only; not private-mail acceptance or authorization.',
  };
}

async function main() {
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: node --import tsx scripts/evaluate-mail-broker.mjs <predictions.json>',
    );
  const artifact = JSON.parse(await readFile(process.argv[2], 'utf8'));
  // Raw prediction arrays remain useful for an explicitly manual offline study.
  // Durable runner/decoder receipts must bind the complete production identity.
  const predictions = Array.isArray(artifact)
    ? artifact
    : validateEvaluationReceipt(artifact);
  const result = scorePredictions(predictions);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Evaluation failed.',
    );
    process.exitCode = 1;
  });
