/**
 * What install itself made of the two things it may share with the rest of the machine: the helper's group and the runner's place in it
 * (D#587 B-2a-2 PR-4). A group or membership that was there before install is not install's to remove, so install writes this record into its
 * own root-owned config directory and uninstall removes only what the record names. A missing, unreadable or malformed record means "nothing":
 * the group and the membership are left, which is the safe direction. Pure: this file only reads and writes text.
 */
export interface InstallRecord {
  readonly group_created: boolean;
  readonly members_added: readonly string[];
}

export const NO_RECORD: InstallRecord = { group_created: false, members_added: [] };

export function parseRecord(text: string): InstallRecord {
  try {
    const r = JSON.parse(text) as Partial<InstallRecord> & { version?: unknown };
    if (r.version === 1 && typeof r.group_created === "boolean" && Array.isArray(r.members_added) && r.members_added.every((m) => typeof m === "string")) return { group_created: r.group_created, members_added: r.members_added };
  } catch {
    // fx-swallow-ok: a record that is not readable is "install recorded nothing", which leaves the group and membership alone
  }
  return NO_RECORD;
}

export function renderRecord(r: InstallRecord): string {
  return `${JSON.stringify({ version: 1, group_created: r.group_created, members_added: [...new Set(r.members_added)].sort() }, null, 2)}\n`;
}

/** The record after one more run: what was recorded stays recorded, so a re-run that finds the group already there does not forget that install made it. */
export function mergeRecord(old: InstallRecord, ran: { readonly groupCreated: boolean; readonly memberAdded: string | undefined }): InstallRecord {
  return { group_created: old.group_created || ran.groupCreated, members_added: ran.memberAdded === undefined ? old.members_added : [...old.members_added, ran.memberAdded] };
}
