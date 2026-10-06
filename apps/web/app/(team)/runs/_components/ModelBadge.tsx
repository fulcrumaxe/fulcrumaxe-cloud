import { createElement } from 'react';

/**
 * D#2 H22: shows a run's routing decision on the run page -- its model,
 * why that model was picked, its expected cost, and what it would have
 * cost on Opus 5 (Spec H22 "Dashboard").
 *
 * Built standalone, NOT registered into a run page: C5 (D#2 correction)
 * narrows H11 to packages/core/src/events/** only, and states plainly
 * that "the (team)/runs/** page ... [is] never built" under this wave --
 * the UI moves to D#37 WS-F2. There is currently no runs/page.tsx for a
 * "one import and one JSX line" registration to land in (confirmed: only
 * apps/web/app/(team)/page.tsx exists). D#37 imports this component when
 * it builds that page.
 *
 * Written with React.createElement rather than JSX: this file's own
 * vitest project (root: apps/web, in vitest.workspace.ts) has no React
 * plugin configured, and tsconfig.json's `"jsx": "preserve"` is meant for
 * Next.js's own build-time transform, not for the plain esbuild transform
 * vitest uses to run this test -- createElement sidesteps that mismatch
 * entirely rather than assuming a JSX-transform config test/1 test file
 * has never exercised.
 */
export interface ModelBadgeProps {
  model: string;
  routeReason: string;
  expectedUsd: number;
  allOpusExpectedUsd: number;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function ModelBadge(props: ModelBadgeProps) {
  return createElement(
    'div',
    { className: 'model-badge', 'data-testid': 'model-badge' },
    createElement('span', { className: 'model-badge__model', 'data-testid': 'model-badge-model' }, props.model),
    createElement('span', { className: 'model-badge__reason', 'data-testid': 'model-badge-reason' }, props.routeReason),
    createElement('span', { className: 'model-badge__cost', 'data-testid': 'model-badge-cost' }, usd(props.expectedUsd)),
    createElement(
      'span',
      { className: 'model-badge__opus-cost', 'data-testid': 'model-badge-opus-cost' },
      `vs. Opus 5: ${usd(props.allOpusExpectedUsd)}`,
    ),
  );
}
