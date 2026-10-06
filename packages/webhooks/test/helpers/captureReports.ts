import { onTestFinished } from 'vitest';
import { configureErrorReporter, type ErrorClass } from '@fx/telemetry';

/**
 * Installs a process-wide error reporter that keeps every stdout line and every stored class in memory, so a
 * test can look at exactly what would leave the process. The reporter is put back when the test finishes.
 */
export function captureReports() {
  const lines: string[] = [];
  const classes: ErrorClass[] = [];
  configureErrorReporter({
    service: 'test',
    write: (line) => {
      lines.push(line);
    },
    sink: {
      record: (event) => {
        classes.push(event);
      },
    },
  });
  onTestFinished(() => configureErrorReporter({ service: 'app' }));
  return {
    lines,
    classes,
    /** Everything that left the reporter, as one string to search for a secret. */
    everything: () => `${lines.join('\n')}\n${JSON.stringify(classes)}`,
  };
}
