export function decodeTable(encoded: string): Map<number, string>;
export function decodeIgnorable(encoded: string): RegExp;
export function loadConfusables(): Promise<void>;
export function confusablesLoaded(): boolean;
export function skeleton(s: string): string;
export function spellsMarker(note: string): boolean;
export function hasAngleRun(note: string): boolean;
