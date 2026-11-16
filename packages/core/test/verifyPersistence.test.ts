import { describe, expect, it } from 'vitest';
import { classifyPersistence, readPersistence } from '../src/verify/criteria.js';
import { deriveJourneys } from '../src/verify/journeys.js';
import { isEvidencedPass, type JourneyResult } from '../src/verify/rows.js';

// D#749 VERIFY-RELOAD-ONLY-FOR-PERSISTED
describe('classifyPersistence', () => {
  const viewOnly = [
    'Picking a role filters the list by that role',
    'Choosing a role and a status filters the list',
    'filter the list by role and status',
    'the Runs app filters by role',
    'Show more reveals older runs',
    'The list sorts by role',
    'Searching narrows the list',
  ];
  // The real criteria that exposed the gap. c2 is a plain reading with no view verb, so it stays persisted (a reload is cheap to give).
  const realCriteria: Array<[string, string, 'persisted' | 'view_only']> = [
    ['c2', 'Above the list are two labelled pickers, Role and Status. Role lists `All` first, then the role names the detail heading already uses (`Triage & Spec · Project manager`, `Build · Executor`, `Review · Code reviewer`, …). Status lists `All` first, then `Waiting` …', 'persisted'],
    ['c3', 'Choosing `Build · Executor` in Role leaves only executor runs in the list, and pressing Show more adds older runs that are all executor runs too.', 'view_only'],
    ['c4', 'Choosing a Status as well (for example Failed) narrows the list further, and every row left shows both that role and that status chip.', 'view_only'],
    ['c5', 'With a Role and Status combination that no run has, the list is replaced by the words `No runs match these filters.` and no Show more button is offered.', 'view_only'],
  ];
  it.each(realCriteria)('the real criterion %s reads as %s', (_id, text, want) => expect(classifyPersistence(text)).toBe(want));
  it.each(viewOnly)('reads %j as view-only', (t) => expect(classifyPersistence(t)).toBe('view_only'));

  // Each wording below once read as view-only (security review): every one must be persisted.
  const persisted = [
    'Saving the nickname keeps it',
    'Show more and keep it',
    'The chosen sort order is kept when you come back',
    'The sort order is remembered',
    'The filter becomes the default view',
    'The chosen filter is your preference from now on',
    'Storing the sort for the team',
    'Creating a filter shows it in the sidebar',
    'Adding a search shortcut puts it in the menu',
    'The filter is still applied after refreshing the page',
    'After a page reload the list is still sorted by name',
    'The sort is the same next time you open the page',
    'Collapsed sections stay collapsed for every visitor',
    'Picking a role filters the list and makes that member an admin',
    'Choosing a status filter marks the item Done',
    'Applying the filter publishes it to the team board',
    'Enabling the filter for everyone on the team',
    'Sorting by date and archiving the oldest item',
    'Grouped by owner, the board moves the card to Done',
    'Toggling the filter turns on email alerts',
    'Search results are recorded in history',
    'Clicking `Save filter` pins the filtered list',
    'Filtering by `keep` shows the list',
    'Sorting raises the priority and lowers the rest',
    'A filter, then `deleteItem`, then a search',
    // Second review: a view verb beside an action verb the lists do not name.
    'Search a run and cancel it',
    'Sorting by priority and closing the top issue',
    'Filter the list and resolve the first incident',
    'Filtering and purging old runs',
    'Filter runs and stop the first one',
    'Filter runs, then retry the failed one',
    'Search the catalogue and buy the first plan',
    'Search for a repo and connect it',
    'Sorting the columns and running the job',
    'Expanding the row and completing the task',
    'Filter the list and vote for the first item',
    'Filtering the list and dismissing the warning',
    'Filtering the done items and clearing them empties the board',
    'Sorting by drag reorders the backlog',
    'Sorting by name sticks',
    'Collapsing the panel is held across visits',
    'Filtered items can be hidden for good',
    'Filtering hides the item until you unhide it',
    'Show more adds older runs and deletes the oldest',
    'Filter and Delete the first run',
    // Third review: finite verbs, other joiners, passives and noun openers.
    'Filtering the list cancels the first run',
    'The filter kills the stuck run',
    'Narrowing the list closes the issue',
    'Choosing Failed filters the list, cancels the run and shows it gone',
    'Filter runs, cancel the first one',
    'Filter runs. Cancel the first one.',
    'Sort by date; the oldest run is purged',
    'Filter the list to cancel the run',
    'Filter the list so the run is cancelled',
    'Filter the list or close it',
    'Search plus connect the repo',
    'Filter, plus close the incident',
    'Filter the runs while you cancel the first',
    'Leaves only open runs once you kill the rest',
    'Filtered runs are cancelled',
    'Filter and the run is killed',
    'Filter the list and all runs are stopped',
    'Filter the list and every item is resolved',
    'Filter the list and the plan is bought',
    'Filter the list, then the oldest run gets purged',
    'Filter the list and the first run cancels',
    'Filter the list and status Done is given to the first item',
    'Picking a status filters the list; the item now shows Done for good',
    'Filter the list and press `cancel` on the first run',
    // Fourth review: action labels, "run" as a verb, other scripts.
    'Filter the runs and press `Rerun`',
    'Filter the list and press `Destroy`',
    'Filter by status and click `Terminate`',
    'Filter the list and press `Wipe`',
    'Filter the runs and press `Unpublish`',
    'Filter the runs and click "Rollback"',
    'Filter the runs and click "Promote"',
    'Filter the runs and click `Restart`',
    'Filter the runs and click `Accept`',
    'Filter the runs and click `Reject`',
    'Filter the runs and click `Erase`',
    'Filter the runs and click `Discard`',
    'Filter the runs and click `Ban`',
    'Filter the runs and click `Run`',
    'Filter the runs (for example Destroy) and press it',
    'Filter the runs; `Destroy` it',
    'Filter the list or run the first one',
    'Filter runs; run the first one',
    'Filter the list, run the first one',
    'Filter the runs and 删除 the first one',
    'Filter the runs and удалить the first one',
    'Choosing `Build · Executor` filters the list and you destroy the executor',
    // Fifth review: option labels reused as verbs, menu items, clause boundaries, "the words" after a press.
    'Choosing `Terminate` in Status filters the list, terminate runs',
    'Choosing `Terminate` in Status filters the list; terminate runs',
    'Choosing `Terminate` in Status filters the list or terminate runs',
    'Pick `Wipe` in Role, filter, wipe rows',
    'Choosing `Rerun` in Status filters the list, rerun runs too',
    'Filter the runs and select `Terminate` in the row',
    'Filter the runs and pick `Destroy` on the first run',
    'Filter the list, then choose `Wipe` in the row',
    'Filter the runs, select `Rerun` on each row',
    'Filter by status and select "Restart" in the first row',
    'Choose a status, `Terminate` the first run and filter the list',
    'Filter the list and click the words `Wipe All Runs`',
    'Filter the list and press the words "Destroy Runs"',
    'Filter the runs; the words `Terminate` are pressed',
    // Sixth review: a picker applied to one row, or a picker that is not Role or Status.
    'Select `Viewer` in Role on the first row and the list filters',
    'Choosing `Done` in Status on the first row narrows the list',
    'Choosing `Failed` in Status of the first run narrows the list',
    'On the first row, choosing `Viewer` in Role filters the list',
    'Pick `Terminate` in the status picker of the first run, the list filters',
    'Choosing a Status (for example Terminate) on the first run narrows the list',
    'Pick `Terminate` in the run picker and the list filters',
    'Choosing `Done` in the status picker of the first row narrows the list',
    // Seventh review: the target is named by position, not by a fixed word shape.
    'Choosing `Done` in Status in the first row narrows the list',
    'Choosing `Done` in Status in each row narrows the list',
    'Choosing `Done` in Status on the older run narrows the list',
    'Choosing `Done` in Status on all rows narrows the list',
    'Choosing `Done` in Status on both rows narrows the list',
    'Choosing `Done` in Status on the first two rows narrows the list',
    'Choosing `Done` in Status on that one row narrows the list',
    'Choosing `Done` in Status on the chip narrows the list',
    'With the first row open, choosing `Viewer` in Role filters the list',
    'Open the first run, choose `Done` in Status and the list filters',
    // Eighth review: bulk targets, targets set up earlier, targets after the view verb.
    'Choosing `Done` in Status on all runs narrows the list',
    'Choosing `Done` in Status in all runs narrows the list',
    'Choosing `Done` in Status on both runs narrows the list',
    'Choosing `Done` in Status on the older runs narrows the list',
    'Choosing `Done` in Status on these runs narrows the list',
    'Choosing a Status as well (for example Done) on all runs narrows the list',
    'Open the first run. Choosing `Done` in Status narrows the list.',
    'Open the first row; choosing `Viewer` in Role filters the list',
    'Pick the first run. Choose `Done` in Status and the list narrows',
    'In row no. 1, choosing `Done` in Status narrows the list',
    'In the first row (no. 1), choosing `Done` in Status narrows the list',
    'In each row; choosing `Done` in Status narrows the list',
    'Choosing `Done` in Status filters the list in the first row',
    'Choosing `Done` in Status narrows the first row',
    'Something else entirely',
    'A filter saved as a view survives a reload',
    '',
  ];
  it.each(persisted)('reads %j as persisted', (t) => expect(classifyPersistence(t)).toBe('persisted'));

  it('readPersistence is a closed vocabulary that fails closed', () => {
    expect(readPersistence('view_only')).toBe('view_only');
    for (const v of [undefined, null, 'VIEW_ONLY', 'other', 3]) expect(readPersistence(v)).toBe('persisted');
  });
});

describe('journey derivation', () => {
  it('marks a filter criterion view-only and leaves a saved-change criterion and standing journeys unmarked', () => {
    const body = ['1. [ui] Choosing a role filters the list by that role.', '2. [ui] Saving the nickname keeps it.'].join('\n');
    const js = deriveJourneys({ specBody: body, standing: [{ id: 'home', text: 'Open the home page and filter nothing' }] });
    expect(js.find((j) => j.id === 'c1')?.persistence).toBe('view_only');
    expect(js.find((j) => j.id === 'c2')?.persistence).toBeUndefined();
    expect(js.find((j) => j.id === 's_home')?.persistence).toBeUndefined();
  });
});

describe('isEvidencedPass', () => {
  const r: JourneyResult = { id: 'c1', result: 'pass', steps: [{ did: 'clicked', dom_fact: 'rows shown' }], console_errors: 0, undo_checked: true, reloaded: false };
  it('needs a reload unless the journey is view-only', () => {
    expect(isEvidencedPass(r)).toBe(false);
    expect(isEvidencedPass(r, 'persisted')).toBe(false);
    expect(isEvidencedPass(r, 'view_only')).toBe(true);
    expect(isEvidencedPass({ ...r, undo_checked: false }, 'view_only')).toBe(false);
  });
});
