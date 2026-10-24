/** Allow only a local invitation return path, never a caller-controlled origin. */
export function invitationReturnPath(value: string | null): string | null {
  return value && /^\/household\/join\?token=[a-f0-9]{64}$/.test(value) ? value : null;
}
