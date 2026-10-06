import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KPI_METRICS } from '../src/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'stats', 'README.md');
const readme = readFileSync(README_PATH, 'utf8');

describe('docs/stats/README.md (D#45 S2 criterion 10)', () => {
  it('contains every KPI_METRICS id', () => {
    for (const metric of KPI_METRICS) {
      expect(readme).toContain(metric.id);
    }
  });

  it('contains "90 days" (C2: run_events retention)', () => {
    expect(readme).toContain('90 days');
  });

  it('does not contain "Claude Code"', () => {
    expect(readme).not.toContain('Claude Code');
  });
});
