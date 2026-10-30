/** The app has no deep link to a single screen, so the one link every email carries is the app origin itself; the copy says where to go once it is open. */

export interface EmailText {
  subject: string;
  text: string;
}

/**
 * Fixed copy, two counts and the Inbox link. Never the question, an option, an answer or a name: the email says only that something waits.
 * `first` is asks never emailed before; `reminder` is overdue asks getting their one reminder.
 */
export function buildEmailText(input: { appOrigin: string; first: number; reminder: number }): EmailText {
  const { first, reminder } = input;
  const total = first + reminder;
  const noun = (n: number): string => `${n} ${n === 1 ? "decision is" : "decisions are"}`;
  const subject = first === 0 ? "Reminder: a decision is overdue" : total === 1 ? "A decision is waiting for you" : `${total} decisions are waiting for you`;
  const lines: string[] = [];
  if (first > 0) lines.push(`${noun(first)} waiting for your answer.`);
  if (reminder > 0) lines.push(`${noun(reminder)} overdue.`);
  lines.push("", `Open Needs you to answer: ${input.appOrigin}`, "", "You get one email per 15 minutes at most, and at most one reminder for each decision.");
  return { subject, text: lines.join("\n") };
}
