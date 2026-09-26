#!/usr/bin/env node
/** Human-side CLI for minting a short-lived, exact-action approval. */

import { readFile } from 'node:fs/promises';
import { approvalSecret, loadConfig } from '../config.js';
import { createApprovalPayload, signApproval } from '../security/approval.js';
import type { VerificationAssertion } from '../types.js';

function parseArgs(args: string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    if (arg === '--confirm' || arg === '--help') {
      parsed.set(arg.slice(2), true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    parsed.set(arg.slice(2), value);
    index += 1;
  }
  return parsed;
}

function required(args: Map<string, string | true>, name: string): string {
  const value = args.get(name);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
}

function parseAssertions(value: unknown): VerificationAssertion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('Assertions file must contain a JSON array with 1–20 assertions.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Assertion ${index + 1} must be an object.`);
    const row = item as Record<string, unknown>;
    if (typeof row.name !== 'string' || !row.name || typeof row.query !== 'string' || !row.query) {
      throw new Error(`Assertion ${index + 1} requires non-empty name and query strings.`);
    }
    const expectation = row.expectation;
    if (expectation === 'scalar_equals') {
      if (!Object.prototype.hasOwnProperty.call(row, 'expected_value')) {
        throw new Error(`Assertion ${index + 1} scalar_equals requires expected_value (explicit null is valid).`);
      }
      const expected = row.expected_value;
      if (expected !== null && !['string', 'number', 'boolean'].includes(typeof expected)) {
        throw new Error(`Assertion ${index + 1} expected_value must be a JSON scalar.`);
      }
      return { name: row.name, query: row.query, expectation, expected_value: expected as string | number | boolean | null };
    }
    if (!['returns_rows', 'returns_no_rows', 'first_value_true'].includes(String(expectation))) {
      throw new Error(`Assertion ${index + 1} has an unsupported expectation.`);
    }
    if (Object.prototype.hasOwnProperty.call(row, 'expected_value')) {
      throw new Error(`Assertion ${index + 1} may use expected_value only with scalar_equals.`);
    }
    return {
      name: row.name,
      query: row.query,
      expectation: expectation as 'returns_rows' | 'returns_no_rows' | 'first_value_true',
    };
  });
}

function usage(): string {
  return [
    'Usage:',
    '  npm run approve -- --sql-file <path> --assertions-file <path>',
    '    --baseline <sha256> --expected <sha256> --rehearsal-id <id>',
    '    --action "<reviewed action>" --confirm',
    '',
    'The assertion file and SQL are both hash-bound. --confirm is intentionally required.',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.get('help') === true) { console.log(usage()); return; }
  if (args.get('confirm') !== true) throw new Error(`Approval not confirmed.\n\n${usage()}`);

  const config = loadConfig('cli');
  const baseline = required(args, 'baseline').toLowerCase();
  const expected = required(args, 'expected').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(baseline) || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('--baseline and --expected must be SHA-256 hex fingerprints.');
  }

  const migrationSql = await readFile(required(args, 'sql-file'), 'utf8');
  const assertions = parseAssertions(
    JSON.parse(await readFile(required(args, 'assertions-file'), 'utf8')) as unknown,
  );
  const payload = createApprovalPayload({
    migrationSql,
    assertions,
    baselineFingerprint: baseline,
    expectedFingerprint: expected,
    rehearsalId: required(args, 'rehearsal-id'),
    action: required(args, 'action'),
    ttlSeconds: config.SF_APPROVAL_TTL_SECONDS,
  });
  const token = signApproval(payload, approvalSecret(config));

  console.error(
    `[SchemaForge] Approved SQL ${payload.migration_hash.slice(0, 12)}… and assertions ` +
      `${payload.assertions_hash.slice(0, 12)}… for ${config.SF_APPROVAL_TTL_SECONDS}s; nonce ${payload.nonce}`,
  );
  console.log(JSON.stringify(token, null, 2));
}

main().catch((error) => {
  console.error(`[SchemaForge] Approval refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
