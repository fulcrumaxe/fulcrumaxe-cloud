import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelBadge } from './ModelBadge';

describe('ModelBadge', () => {
  it('renders a fixture run with all four fields: model, route reason, expected cost, opus-equivalent cost', () => {
    const html = renderToStaticMarkup(
      ModelBadge({
        model: 'sonnet-5',
        routeReason: 'table v1: executor/Feature',
        expectedUsd: 4.2,
        allOpusExpectedUsd: 21,
      }),
    );

    expect(html).toContain('sonnet-5');
    expect(html).toContain('table v1: executor/Feature');
    expect(html).toContain('$4.20');
    expect(html).toContain('$21.00');
  });
});
