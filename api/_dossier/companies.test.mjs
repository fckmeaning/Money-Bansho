import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import companies from './companies.js';

describe('dossier company list', () => {
  const shared = JSON.parse(readFileSync(new URL('../../shared/dossier-companies.json', import.meta.url), 'utf8'));

  it('api/_dossier/companies.js matches shared/dossier-companies.json', () => {
    assert.deepStrictEqual(companies, shared);
  });

  it('has unique symbols and the required fields', () => {
    assert.equal(new Set(shared.map((c) => c.symbol)).size, shared.length);
    for (const c of shared) {
      assert.ok(c.symbol && c.name && c.aliases.length && c.country && c.region && c.benchmark, c.symbol);
    }
  });
});
