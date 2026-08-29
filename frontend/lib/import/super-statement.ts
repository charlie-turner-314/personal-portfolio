import { createHash } from "crypto";

export function createSuperStatementRowHash(
  importId: string,
  rowIndex: number,
  row: string[],
): string {
  return createHash("sha256")
    .update(`${importId}\u0000${rowIndex}\u0000${JSON.stringify(row)}`)
    .digest("hex");
}
