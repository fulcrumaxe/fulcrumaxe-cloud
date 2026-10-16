/** A SQL LIKE pattern (backslash escape) as a regular expression, to hold the patterns to the key shapes without a database. */
export const likeToRegex = (p: string): RegExp => new RegExp(`^${p.replace(/\\(.)/g, "\u0000$1").replace(/%/g, ".*").replace(/_/g, ".").replace(/\u0000(.)/g, (_m, c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}$`);
