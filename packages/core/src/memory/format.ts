import { MEMORY_STATUSES, type MemoryAuthorKind, type MemoryKind, type MemoryProvenance, type MemoryScope, type MemoryStatus } from './index.js';

/**
 * D#601 MEM-4a1b: the one place memory text is shaped for a screen. Database rows hold nulls (no reason, a deleted user, a repo never synced),
 * and a screen that prints a null prints the word "null". None of these functions returns null, undefined, "null" or "undefined".
 */

/** A value as display text: its trimmed text, or `fallback` for a null, an undefined, an empty string, or the words "null" and "undefined". */
export function memoryText(value: unknown, fallback = ''): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text === '' || text === 'null' || text === 'undefined' ? fallback : text;
}

export interface MemoryStatusDisplay {
  /** The words shown next to the icon. Status is never colour alone. */
  label: string;
  /** A symbolic icon name for the screen to draw: one of a fixed set, so a stylesheet can map every one. */
  icon: 'inbox' | 'check' | 'cross' | 'clock' | 'pause' | 'trash' | 'archive' | 'replace' | 'question';
}

const STATUS_DISPLAY: Readonly<Record<MemoryStatus, MemoryStatusDisplay>> = {
  proposed: { label: 'Proposed', icon: 'inbox' },
  approved: { label: 'Approved', icon: 'check' },
  rejected: { label: 'Rejected', icon: 'cross' },
  expired: { label: 'Expired', icon: 'clock' },
  retired: { label: 'Retired', icon: 'pause' },
  deleted: { label: 'Deleted', icon: 'trash' },
  archived: { label: 'Archived', icon: 'archive' },
  superseded: { label: 'Replaced by a newer version', icon: 'replace' },
};

/** The label and icon of a status. A value that is not one of the eight gets "Unknown status", never a blank. */
export function formatMemoryStatus(status: unknown): MemoryStatusDisplay {
  return (MEMORY_STATUSES as readonly unknown[]).includes(status) ? STATUS_DISPLAY[status as MemoryStatus] : { label: 'Unknown status', icon: 'question' };
}

const KIND_LABEL: Readonly<Record<MemoryKind, string>> = {
  convention: 'Convention',
  command: 'Command',
  fact: 'Fact',
  gotcha: 'Gotcha',
  preference: 'Preference',
  decision: 'Decision',
};

export function formatMemoryKind(kind: unknown): string {
  return KIND_LABEL[kind as MemoryKind] ?? 'Note';
}

/** The first line of the body, whitespace collapsed, at most 80 characters. A body is never empty, but a blank one still gets a name. */
export function formatMemoryTitle(body: unknown, scope?: MemoryScope, kind?: MemoryKind): string {
  const first = memoryText(typeof body === 'string' ? (body.split('\n').find((l) => l.trim() !== '') ?? '') : '').replace(/\s+/g, ' ');
  if (first === '') return `${memoryText(scope, 'memory')} ${formatMemoryKind(kind).toLowerCase()}`;
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
}

/** Who wrote the bytes, as the list shows it. An import names its file (the last path segment only: a path is the repo's, not ours to print). */
export function formatMemorySource(authorKind: unknown, provenance: MemoryProvenance | null | undefined): string {
  switch (authorKind as MemoryAuthorKind) {
    case 'person':
      return 'A member';
    case 'agent':
      return 'Agent';
    case 'assistant':
      return 'Assistant';
    case 'runner_agent':
      return 'Runner agent';
    case 'import': {
      const file = memoryText(provenance?.source_path).split('/').pop() ?? '';
      return file === '' ? 'Imported from a repo file' : `Imported from ${file}`;
    }
    default:
      return 'Unknown source';
  }
}

/** The card's provenance line. The wording for an agent proposal is fixed ("Proposed by agent (run <id>)") and survives an edit. */
export function formatMemoryProposedBy(authorKind: unknown, provenance: MemoryProvenance | null | undefined): string {
  const run = memoryText(provenance?.source_run_id);
  const withRun = (who: string) => (run === '' ? `Proposed by ${who}` : `Proposed by ${who} (run ${run})`);
  switch (authorKind as MemoryAuthorKind) {
    case 'person':
      return 'Proposed by a member';
    case 'agent':
      return withRun('agent');
    case 'assistant':
      return withRun('the assistant');
    case 'runner_agent':
      return withRun('a runner agent');
    case 'import': {
      const file = memoryText(provenance?.source_path).split('/').pop() ?? '';
      const commit = memoryText(provenance?.source_commit).slice(0, 7);
      return `${file === '' ? 'Imported from a repo file' : `Imported from ${file}`}${commit === '' ? '' : ` at ${commit}`}`;
    }
    default:
      return 'Unknown source';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in the largest whole unit. `now` is a parameter so a test does not depend on the clock. */
export function formatMemoryAge(createdAt: Date | string | null | undefined, now: Date = new Date()): string {
  const at = createdAt instanceof Date ? createdAt.getTime() : createdAt === null || createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (!Number.isFinite(at)) return 'Unknown age';
  const ms = Math.max(0, now.getTime() - at);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (ms < MINUTE) return 'Just now';
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), 'minute');
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  if (ms < 60 * DAY) return plural(Math.floor(ms / DAY), 'day');
  return plural(Math.floor(ms / (30 * DAY)), 'month');
}

/** "Used in N runs" for a count that is always a number. */
export function formatMemoryRuns(runs: unknown): string {
  const n = typeof runs === 'number' && Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 0;
  return `Used in ${n} ${n === 1 ? 'run' : 'runs'}`;
}

/** The name of a repo group: `owner/name`, or the plain statement that the repo is gone. */
export function formatRepoGroup(owner: unknown, name: unknown): string {
  const o = memoryText(owner);
  const n = memoryText(name);
  return o !== '' && n !== '' ? `${o}/${n}` : 'Repo no longer connected';
}

/** The name of an item group: its number and title, with the number alone or the title alone when that is all there is. */
export function formatItemGroup(number: unknown, title: unknown): string {
  const num = typeof number === 'string' || typeof number === 'number' ? memoryText(String(number)) : '';
  const t = memoryText(title);
  if (num !== '' && t !== '') return `#${num} ${t}`;
  if (num !== '') return `#${num}`;
  return t === '' ? 'Item' : t;
}

/** What the history shows for each audit action: a fixed phrase, never the raw action text. */
const HISTORY_LABEL: Readonly<Record<string, string>> = {
  'memory.proposed': 'Proposed',
  'memory.written': 'Written by a member',
  'memory.approved': 'Approved',
  'memory.rejected': 'Rejected',
  'memory.retired': 'Retired',
  'memory.reverted': 'Moved back to proposed',
  'memory.edited': 'Edited',
  'memory.deleted': 'Deleted',
  'memory.restored': 'Restored',
  'memory.receipt_promoted': 'Added from a decision receipt',
  'memory.expired': 'Expired',
  'memory.purged': 'Removed after 30 days',
};

export function formatMemoryHistoryAction(action: unknown): string {
  return typeof action === 'string' ? (HISTORY_LABEL[action] ?? 'Changed') : 'Changed';
}

/** Who did a history event, as words. A person is "A member" here; the screen swaps in the name it holds for the user id. */
export function formatMemoryHistoryActor(actor: { kind: 'person' } | { kind: 'system'; source: string } | { kind: 'unknown' }): string {
  if (actor.kind === 'person') return 'A member';
  if (actor.kind === 'system') return actor.source === 'memory_sweep' ? 'Memory sweep' : 'The pipeline';
  return 'Unknown';
}
