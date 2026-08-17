/** Narrows an intentionally partial collaborator at a test boundary. */
export function testDouble<T>(value: unknown): T {
  // SAFETY: Each test supplies every collaborator member exercised by its scenario.
  return value as T;
}
