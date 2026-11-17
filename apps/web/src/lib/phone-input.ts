/**
 * Keeps only what a phone number can hold — digits, spaces, hyphens and a leading + — as the user types or pastes,
 * so letters never reach a phone field. Pass `maxLength` here instead of on the <input>: the browser would cut a
 * pasted "Mob: +91 98110 00000" to length before the letters are dropped, losing digits. Format rules (10-digit
 * mobile, landline length) stay with each form's validation.
 */
export const phoneInput = (raw: string, maxLength?: number): string => {
  const kept = raw.replace(/[^\d\s+-]/g, '').trimStart().replace(/(?!^)\+/g, '');
  return maxLength ? kept.slice(0, maxLength) : kept;
};
