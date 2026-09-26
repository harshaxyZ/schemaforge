/** Read-only production postcondition and schema-fingerprint verification. */

import { db } from '../db.js';
import { inspectSchemaWithClient } from './inspect_schema.js';
import { runAssertion } from '../verification.js';
import type {
  Evidence,
  SchemaFingerprint,
  VerificationAssertion,
  VerificationAssertionResult,
} from '../types.js';

export interface VerifyProductionInput {
  expected_fingerprint: string;
  verification_assertions: VerificationAssertion[];
}

export interface VerifyProductionResult {
  expected_fingerprint: string;
  current_fingerprint: SchemaFingerprint;
  fingerprint_matches: boolean;
  all_checks_passed: boolean;
  checks: VerificationAssertionResult[];
  evidence: Evidence[];
}

export async function verifyProduction(
  input: VerifyProductionInput,
): Promise<VerifyProductionResult> {
  if (!/^[a-f0-9]{64}$/i.test(input.expected_fingerprint)) {
    throw new Error('expected_fingerprint must be a SHA-256 hex digest.');
  }
  if (input.verification_assertions.length === 0) {
    throw new Error('At least one machine-checkable verification assertion is required.');
  }

  return db.withTransaction(
    'prodReadonly',
    async (client) => {
      const currentFingerprint = (await inspectSchemaWithClient(client)).fingerprint;
      const fingerprintMatches =
        currentFingerprint.hash === input.expected_fingerprint.toLowerCase();
      const evidence: Evidence[] = [
        {
          check_name: 'schema_fingerprint_match',
          status: fingerprintMatches ? 'PASS' : 'FAIL',
          details: fingerprintMatches
            ? 'Production schema matches the rehearsed post-migration fingerprint.'
            : `Schema mismatch: expected ${input.expected_fingerprint}, observed ${currentFingerprint.hash}.`,
          is_estimate: false,
        },
      ];
      const checks: VerificationAssertionResult[] = [];

      for (const [index, assertion] of input.verification_assertions.entries()) {
        const savepoint = `sf_verify_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await runAssertion(client, assertion);
          checks.push(result);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          evidence.push({
            check_name: `production_assertion:${assertion.name}`,
            status: result.passed ? 'PASS' : 'FAIL',
            details: result.passed ? `Assertion "${assertion.name}" passed.` : `Assertion "${assertion.name}" failed.`,
            measured_value: `${result.row_count} rows [OBSERVED]`,
            is_estimate: false,
          });
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          const message = error instanceof Error ? error.message : String(error);
          checks.push({
            name: assertion.name,
            query: assertion.query,
            expectation: assertion.expectation,
            ...(assertion.expected_value !== undefined ? { expected_value: assertion.expected_value } : {}),
            passed: false,
            row_count: 0,
            rows: [],
            error: message,
          });
          evidence.push({
            check_name: `production_assertion:${assertion.name}`,
            status: 'FAIL',
            details: message,
            is_estimate: false,
          });
        }
      }

      return {
        expected_fingerprint: input.expected_fingerprint.toLowerCase(),
        current_fingerprint: currentFingerprint,
        fingerprint_matches: fingerprintMatches,
        all_checks_passed: fingerprintMatches && checks.every((check) => check.passed),
        checks,
        evidence,
      };
    },
    { readOnly: true, isolationLevel: 'REPEATABLE READ' },
  );
}
