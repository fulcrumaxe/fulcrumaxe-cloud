/**
 * Reads `key` from `o` only if it is an OWN DATA property, once. A property
 * inherited through the prototype chain (`Object.prototype.x = ...`), an
 * accessor (its getter is never invoked) and a missing key all read as
 * `undefined`. Use it for every field of an untrusted object that feeds a
 * trust decision.
 */
export function ownData(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d !== undefined && "value" in d ? d.value : undefined;
}
