/**
 * D#749: where a browser journey starts. The workspace is a desktop of apps with no address per screen, so a tester that is only given the base URL has to guess which
 * app holds the screen a journey names, and when it guesses wrong it answers `blocked` and the whole row ends `unverified`. A criterion can therefore carry a marker
 * `[start: <app id>]`; the id must be one of the closed list below (the first-party apps, by the id of their directory under apps/workspace/apps), and the prompt tells
 * the tester to open that app first. The marker is never free text: an id that is not on the list is dropped, so nothing a Spec or an outsider's issue wrote can name a
 * page, a URL or an instruction. The list holds the window title each app registers, which the prompt prints (a test pins both against the app manifests).
 */
export const VERIFY_START_APPS: Readonly<Record<string, string>> = {
  'budget-billing': 'Budget & Billing',
  developer: 'Developer',
  memory: 'Memory',
  'model-key': 'Model Key',
  'needs-you': 'Needs you',
  onboarding: 'Onboarding',
  pipeline: 'Pipeline',
  repos: 'Repos',
  roles: 'Roles',
  runners: 'Runners',
  runs: 'Runs',
  'site-review': 'Site review',
  team: 'Team',
  vercel: 'Vercel',
};

export function isStartApp(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(VERIFY_START_APPS, id);
}

export function startAppTitle(id: string): string {
  return VERIFY_START_APPS[id]!;
}

const START_MARKER = /\[\s*start\s*:\s*([^\]\n]{0,80}?)\s*\]/gi;

/** Takes every `[start: <id>]` marker out of a criterion's text. `start` is the first marker whose id is on the closed list; markers with other ids are removed and ignored. */
export function extractStart(text: string): { text: string; start?: string } {
  let start: string | undefined;
  const stripped = text.replace(START_MARKER, (_m, id: string) => {
    const lower = id.toLowerCase();
    if (start === undefined && isStartApp(lower)) start = lower;
    return ' ';
  });
  const clean = stripped.replace(/\s+/g, ' ').trim();
  return start === undefined ? { text: clean } : { text: clean, start };
}
