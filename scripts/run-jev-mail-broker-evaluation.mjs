// Explicit opt-in Jev synthetic experiment. Never reads an owner database/mailbox.
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  jevEvaluationQuote,
  prepareJevEvaluation,
} from './prepare-jev-mail-broker-evaluation.mjs';
import { exchangeJev } from '../apps/api/src/ai/jev-broker-protocol.ts';

export const jevVerifiedEvaluationQuote = {
  revision: 'typesafe-jev-1.14.0-2026-10-19',
  validUntil: '2026-11-19T00:00:00Z',
  inputMicrosPerMillionTokens: 42000,
  outputMicrosPerMillionTokens: 0,
};

export async function runJevEvaluation({
  directory,
  maxMicros,
  secret,
  execute = false,
  fetcher = fetch,
  now = () => Date.now(),
}) {
  if (
    !execute ||
    !secret ||
    !Number.isSafeInteger(maxMicros) ||
    maxMicros < 1 ||
    maxMicros > 250000 ||
    now() >= Date.parse(jevVerifiedEvaluationQuote.validUntil)
  )
    throw new Error(
      'Explicit synthetic execution, key, current verified quote and cap required.',
    );
  const prepared = await prepareJevEvaluation();
  if (
    prepared.quote.inputMicrosPerMillionTokens !==
      jevVerifiedEvaluationQuote.inputMicrosPerMillionTokens ||
    prepared.quote.outputMicrosPerMillionTokens !==
      jevVerifiedEvaluationQuote.outputMicrosPerMillionTokens ||
    prepared.quote.maximumChargeMicros !==
      jevEvaluationQuote.maximumChargeMicros
  )
    throw new Error(
      'Jev evaluation quote does not match the production bound.',
    );

  await mkdir(directory, { mode: 0o700 });
  const journal = await open(join(directory, 'journal.jsonl'), 'wx', 0o600);
  const append = async (entry) => {
    await journal.writeFile(
      JSON.stringify({ recordedAt: new Date(now()).toISOString(), ...entry }) +
        '\n',
    );
    await journal.sync();
  };
  let confirmedMicros = 0;
  let heldMicros = 0;
  const predictions = [];
  const outcomes = [];
  let stopReason = 'complete';
  try {
    await append({
      kind: 'experiment',
      adapter: prepared.adapter,
      corpus: prepared.corpus,
      corpusSha256: prepared.corpusSha256,
      model: prepared.model,
      rubric: prepared.rubric,
      bounds: prepared.bounds,
      threshold: prepared.threshold,
      maxMicros,
      quote: { ...prepared.quote, ...jevVerifiedEvaluationQuote },
    });
    for (const item of prepared.cases) {
      if (now() >= Date.parse(jevVerifiedEvaluationQuote.validUntil)) {
        stopReason = 'quote-expired';
        break;
      }
      const reservation = prepared.quote.maximumChargeMicros;
      if (confirmedMicros + heldMicros + reservation > maxMicros) {
        stopReason = 'cap';
        break;
      }
      // Admission is durable before the one and only network attempt. A crash
      // after this record is uncertain and this directory cannot be resumed.
      await append({
        kind: 'admitted',
        caseId: item.caseId,
        requestSha256: item.requestSha256,
        reservedMicros: reservation,
      });
      heldMicros += reservation;
      const result = await exchangeJev(
        fetcher,
        secret,
        item.envelope,
        prepared.model,
        item.candidates,
        prepared.quote,
      );
      await append({ kind: 'outcome', caseId: item.caseId, result });
      outcomes.push({
        caseId: item.caseId,
        status: result.status,
        reason: result.reason,
      });
      if (result.status === 'confirmed') {
        heldMicros -= reservation;
        confirmedMicros += result.usage.actualMicros;
      }
      if (result.status !== 'confirmed' || result.reason !== null) {
        stopReason =
          result.status === 'uncertain' ? 'uncertain' : 'invalid-output';
        break;
      }
      predictions.push({
        caseId: item.caseId,
        selectedKeys: result.decisions
          .filter((decision) => decision.selected)
          .map((decision) => decision.id),
      });
    }
    const receipt = {
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
      valid: predictions.length === prepared.cases.length,
      confirmedMicros,
      heldMicros,
      maxMicros,
      stopReason,
      outcomes,
      predictions,
    };
    await append({ kind: 'finished', ...receipt });
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(receipt, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    return receipt;
  } finally {
    await journal.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    args[0] !== '--execute-synthetic' ||
    args[1] !== '--max-micros' ||
    args[3] !== '--journal' ||
    !/^\d+$/.test(args[2])
  )
    throw new Error('Explicit execution arguments required.');
  const result = await runJevEvaluation({
    execute: true,
    maxMicros: Number(args[2]),
    directory: args[4],
    secret: process.env.AI_SECRET_JEV,
  });
  console.log(
    JSON.stringify({
      valid: result.valid,
      stopReason: result.stopReason,
      confirmedMicros: result.confirmedMicros,
      heldMicros: result.heldMicros,
    }),
  );
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Jev synthetic evaluation stopped. Preserve the local journal; do not retry uncertain admissions or reuse its directory.',
    );
    process.exitCode = 1;
  });
