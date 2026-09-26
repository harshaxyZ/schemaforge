import type { PoolClient } from 'pg';
import type {
  JsonScalar,
  VerificationAssertion,
  VerificationAssertionResult,
} from './types.js';
import { requireReadonlyQuery } from './security/sql_policy.js';

function asScalar(value: unknown): JsonScalar | undefined {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? (value as JsonScalar)
    : undefined;
}

function scalarsEqual(actual: JsonScalar | undefined, expected: JsonScalar): boolean {
  if (actual === undefined) return false;
  if (Object.is(actual, expected)) return true;
  if (typeof actual === 'number' && typeof expected === 'string') return String(actual) === expected;
  if (typeof actual === 'string' && typeof expected === 'number') return actual === String(expected);
  return false;
}

export async function runAssertion(
  client: PoolClient,
  assertion: VerificationAssertion,
  rowLimit = 50,
): Promise<VerificationAssertionResult> {
  const query = requireReadonlyQuery(assertion.query);
  const result = await client.query(`SELECT * FROM (${query}) AS __sf_assertion LIMIT ${rowLimit + 1}`);
  const rows = result.rows.slice(0, rowLimit) as Record<string, unknown>[];
  const firstRow = rows[0];
  const firstValue = firstRow ? asScalar(firstRow[Object.keys(firstRow)[0] ?? '']) : undefined;

  let passed = false;
  switch (assertion.expectation) {
    case 'returns_rows':
      passed = result.rows.length > 0;
      break;
    case 'returns_no_rows':
      passed = result.rows.length === 0;
      break;
    case 'first_value_true':
      passed = firstValue === true;
      break;
    case 'scalar_equals':
      passed = result.rows.length > 0 && scalarsEqual(firstValue, assertion.expected_value);
      break;
  }

  return {
    name: assertion.name,
    query: assertion.query,
    expectation: assertion.expectation,
    ...(assertion.expectation === 'scalar_equals' ? { expected_value: assertion.expected_value } : {}),
    ...(firstValue !== undefined ? { actual_value: firstValue } : {}),
    passed,
    row_count: Math.min(result.rows.length, rowLimit),
    rows,
    error: null,
  };
}
