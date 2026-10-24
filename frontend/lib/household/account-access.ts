import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Evaluate live membership in the same SQL statement as the protected resource. */
export function sameHousehold(leftUserId: SQL | AnyPgColumn | string, rightUserId: SQL | AnyPgColumn | string): SQL {
  return sql`coalesce((select owner_user_id from household_memberships where member_user_id = ${leftUserId}), ${leftUserId})
    = coalesce((select owner_user_id from household_memberships where member_user_id = ${rightUserId}), ${rightUserId})`;
}

/** Own or explicitly shared accounts. Never use for credentials or sharing management. */
export function accountAccess(accountId: AnyPgColumn | SQL, actorUserId: string | SQL | AnyPgColumn): SQL {
  return sql`${accountId} in (
    select permitted_account.id from accounts permitted_account
    where permitted_account.user_id = ${actorUserId}
    or exists (
      select 1 from household_account_shares permitted_share
      where permitted_share.account_id = permitted_account.id
        and permitted_share.member_user_id = ${actorUserId}
        and permitted_share.granted_by_user_id = permitted_account.user_id
        and ${sameHousehold(sql`permitted_account.user_id`, actorUserId)}
    )
  )`;
}

/** Link records inherit permission from the transaction's account, not their creator. */
export function transactionAccess(transactionId: AnyPgColumn, actorUserId: string): SQL {
  return sql`${transactionId} in (select accessible_transaction.id from transactions accessible_transaction
    where ${accountAccess(sql`accessible_transaction.account_id`, actorUserId)})`;
}
