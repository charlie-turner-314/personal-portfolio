import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { LIABILITY_ACCOUNT_TYPE_VALUES } from "@/lib/constants/account-types";
import { propertyOwnershipShareSql } from "@/lib/people/ownership-sql";
import { accountAccess, propertyAccess, sameHousehold } from "./account-access";

/** Economic ownership is independent of access. Resolve dated allocations first. */
function accountShare(owner: SQL): SQL {
  const actorPeople = sql`select id from people where linked_user_id = ${owner} or (user_id = ${owner} and kind = 'self')
    union select person_id from household_memberships where member_user_id = ${owner}`;
  return sql`case
    when exists(select 1 from account_ownership_allocations h where h.account_id = accounts.id) then coalesce((
      select sum(a.share) from account_ownership_allocations a where a.account_id = accounts.id
        and a.person_id in (${actorPeople}) and a.effective_from = (
          select max(d.effective_from) from account_ownership_allocations d
          where d.account_id = accounts.id and d.effective_from <= current_date
        )
    ), 0)
    when exists(select 1 from account_owners l where l.account_id = accounts.id) then coalesce((
      select sum(coalesce(l.share, 1.0 / (select count(*) from account_owners n where n.account_id = accounts.id)))
      from account_owners l where l.account_id = accounts.id and l.person_id in (${actorPeople})
    ), 0)
    else case when accounts.user_id = ${owner} then 1 else 0 end end`;
}

export type VisibleNetWorthTotal = { userId: string; name: string | null; currency: string; total: string | null; isOwn: boolean };

/** Server-only aggregate projection. Granting a total never grants underlying rows. */
export async function getVisibleNetWorthTotals(actorUserId: string): Promise<VisibleNetWorthTotal[]> {
  const owner = sql`visible_owner.id`;
  const rows = await db.transaction(async tx => {
    // This per-household projection has many permission/ownership expressions but
    // few rows. JIT compilation can cost seconds more than the aggregation itself.
    // Keep this transaction-local so other queries and pooled sessions are unaffected.
    await tx.execute(sql`SET LOCAL jit = off`);
    return tx.execute(sql`
    with visible_owners as materialized (
      select u.id, u.name, coalesce(u.functional_currency, 'EUR') as currency
      from users u where u.id = ${actorUserId}
        or exists(select 1 from household_net_worth_shares g
          where g.owner_user_id = u.id and g.member_user_id = ${actorUserId}
            and ${sameHousehold(sql`u.id`, actorUserId)})
    ), account_inputs as materialized (
      select visible_owner.id as user_id, visible_owner.name, visible_owner.currency as target_currency,
        coalesce(account_owner.functional_currency, 'EUR') as source_currency,
        accounts.id as account_id, accounts.account_type, accounts.functional_balance, accounts.starting_balance,
        ${accountShare(owner)} as ownership_share
      from visible_owners visible_owner cross join accounts
      join users account_owner on account_owner.id = accounts.user_id
      left join super_accounts super on super.account_id = accounts.id
      where accounts.is_active = true and coalesce(super.include_in_net_worth, true)
        and ${accountAccess(accounts.id, owner)}
    ), values_to_convert as materialized (
      select user_id, name, target_currency, source_currency,
        case when ownership_share = 0 then 0 else ownership_share * case
          when input.account_type in ('investment_brokerage', 'investment_manual')
            and exists(select 1 from holdings h where h.account_id = input.account_id)
          then case when exists(
              select 1 from holdings h where h.account_id = input.account_id
                and not exists(select 1 from holding_valuations v where v.holding_id = h.id)
            ) then null else (
              select sum((select v.value_user_currency from holding_valuations v
                where v.holding_id = h.id order by v.date desc limit 1))
              from holdings h where h.account_id = input.account_id
            ) end
          when input.account_type in (${sql.join(LIABILITY_ACCOUNT_TYPE_VALUES.map((type) => sql`${type}`), sql`, `)})
            then -abs(coalesce(input.functional_balance, input.starting_balance, 0))
          else coalesce(input.functional_balance, input.starting_balance, 0)
        end end as value
      from account_inputs input
      union all
      select visible_owner.id, visible_owner.name, visible_owner.currency, coalesce(p.currency, visible_owner.currency),
        coalesce(p.current_value, 0) * ${propertyOwnershipShareSql({ userId: owner }, sql`p.id`)}
      from visible_owners visible_owner cross join properties p
      where p.is_active = true and ${propertyAccess(sql`p.id`, owner)}
      union all
      select visible_owner.id, visible_owner.name, visible_owner.currency, coalesce(v.currency, visible_owner.currency),
        coalesce(v.current_value, 0) * case when exists(select 1 from vehicle_owners vo where vo.vehicle_id = v.id)
          then coalesce((select sum(coalesce(vo.share, 1.0 / (select count(*) from vehicle_owners n where n.vehicle_id = v.id)))
            from vehicle_owners vo join people person on person.id = vo.person_id
            where vo.vehicle_id = v.id and person.user_id = visible_owner.id and person.kind = 'self'), 0)
          else 1 end
      from visible_owners visible_owner join vehicles v on v.user_id = visible_owner.id where v.is_active = true
    ), converted as materialized (
      select value_row.*, case when value = 0 then 0 when source_currency = target_currency then value else value * coalesce(
        (select rate from exchange_rates e where e.base_currency = source_currency and e.target_currency = target_currency order by e.date desc limit 1),
        (select 1 / nullif(rate, 0) from exchange_rates e where e.base_currency = target_currency and e.target_currency = source_currency order by e.date desc limit 1)
      ) end as converted_value from values_to_convert value_row
    )
    select visible_owner.id as user_id, visible_owner.name, visible_owner.currency,
      case when count(converted.user_id) filter(where converted.converted_value is null) > 0
        then null else coalesce(sum(converted.converted_value), 0)::text end as total
    from visible_owners visible_owner left join converted on converted.user_id = visible_owner.id
    group by visible_owner.id, visible_owner.name, visible_owner.currency
    order by visible_owner.id
  `);
  });
  return rows.map((row) => ({ userId: String(row.user_id), name: row.name as string | null,
    currency: String(row.currency), total: row.total as string | null, isOwn: row.user_id === actorUserId }));
}
