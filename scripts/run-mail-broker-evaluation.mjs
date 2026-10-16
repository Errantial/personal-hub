// Explicit opt-in synthetic experiment. Never reads an owner database or mailbox.
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareEvaluation } from './prepare-mail-broker-evaluation.mjs';
import { exchangeBroker } from '../apps/api/src/ai/broker-protocol.ts';
import { verifyBrokerEndpoint } from '../apps/api/src/ai/broker-policy.ts';

export const evaluationQuote = {
  validUntil: '2026-11-15T00:00:00Z',
  inputMicrosPerMillionTokens: 100000,
  outputMicrosPerMillionTokens: 400000,
};

export async function runEvaluation({
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
    now() >= Date.parse(evaluationQuote.validUntil)
  )
    throw new Error(
      'Explicit synthetic execution, key, current quote and cap required.',
    );
  const prepared = await prepareEvaluation();
  if (
    prepared.quote.maximumChargeMicros <
    Math.ceil(
      (prepared.quote.inputTokenLimit *
        evaluationQuote.inputMicrosPerMillionTokens +
        prepared.quote.outputTokenLimit *
          evaluationQuote.outputMicrosPerMillionTokens) /
        1000000,
    )
  )
    throw new Error(
      'Evaluation quote does not cover its declared token bounds.',
    );
  // mkdir is exclusive: no resume, concurrent runner or rerun in this directory.
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
      corpus: prepared.corpus,
      corpusSha256: prepared.corpusSha256,
      model: prepared.model,
      rubric: prepared.rubric,
      maxMicros,
      quote: { ...prepared.quote, ...evaluationQuote },
    });
    for (const item of prepared.cases) {
      if (now() >= Date.parse(evaluationQuote.validUntil)) {
        stopReason = 'quote-expired';
        break;
      }
      const reservation = prepared.quote.maximumChargeMicros;
      if (confirmedMicros + heldMicros + reservation > maxMicros) {
        stopReason = 'cap';
        break;
      }
      try {
        await verifyBrokerEndpoint(fetcher, {
          model: prepared.model,
          inputTokenLimit: prepared.quote.inputTokenLimit,
          ...evaluationQuote,
        });
      } catch {
        stopReason = 'endpoint-blocked';
        break;
      }
      if (now() >= Date.parse(evaluationQuote.validUntil)) {
        stopReason = 'quote-expired';
        break;
      }
      // fsync admission before handing bytes to the transport. A crash from
      // this point onward is uncertain; this journal is never resumed.
      await append({
        kind: 'admitted',
        caseId: item.caseId,
        requestSha256: item.requestSha256,
        reservedMicros: reservation,
      });
      heldMicros += reservation;
      const result = await exchangeBroker(
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
          .filter((d) => d.selected)
          .map((d) => d.id),
      });
    }
    const receipt = {
      corpus: prepared.corpus,
      corpusSha256: prepared.corpusSha256,
      model: prepared.model,
      rubric: prepared.rubric,
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
  const result = await runEvaluation({
    execute: true,
    maxMicros: Number(args[2]),
    directory: args[4],
    secret: process.env.AI_SECRET_OPENROUTER,
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
      'Synthetic evaluation stopped. Inspect the local journal; do not retry uncertain admissions or reuse an existing directory.',
    );
    process.exitCode = 1;
  });
