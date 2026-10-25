import { getAccounts, getAccountsFreshness } from "@/lib/actions/accounts";
import {
  getProperties,
  getPropertyLiabilityLinks,
  getPropertyValuations,
} from "@/lib/actions/properties";
import { getVehicles } from "@/lib/actions/vehicles";
import { getPeople, getOwnersForEntities } from "@/lib/people";
import { avatarUrl } from "@/lib/people/avatars";
import { getHouseholdAccess } from "@/lib/household/access";
import { requireAuth } from "@/lib/household/financial-auth";
import { AssetManagement } from "./asset-management";

function ownerIdsByEntity(
  map: Map<string, { personId: string }[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, owners] of map) {
    out[id] = owners.map((o) => o.personId);
  }
  return out;
}

export async function AssetsSection() {
  const userId = await requireAuth();
  const access = userId ? await getHouseholdAccess(userId) : null;

  const [accounts, properties, vehicles, peopleRows] = await Promise.all([
    getAccounts(),
    getProperties(),
    getVehicles(),
    access ? getPeople(access.ownerUserId).then((rows) => rows.map((person) => ({ ...person, kind: access.personId ? (person.id === access.personId ? "self" : "member") : person.kind }))) : Promise.resolve([]),
  ]);

  // Batch-fetch owners for all visible entities in parallel — avoids N waterfall
  // requests from <OwnerBadges> on each row.
  const [accountOwnersMap, propertyOwnersMap, vehicleOwnersMap, accountFreshness] =
    await Promise.all([
      getOwnersForEntities("account", accounts.map((a) => a.id)),
      getOwnersForEntities("property", properties.map((p) => p.id)),
      getOwnersForEntities("vehicle", vehicles.map((v) => v.id)),
      getAccountsFreshness(accounts.map((account) => account.id)),
    ]);
  const propertyIds = properties.map((property) => property.id);
  const [propertyLiabilityLinks, propertyValuations] = await Promise.all([
    getPropertyLiabilityLinks(propertyIds),
    getPropertyValuations(propertyIds),
  ]);

  const people = peopleRows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    color: p.color,
    avatarUrl: avatarUrl(p.avatarPath),
  }));

  return (
    <AssetManagement
      initialAccounts={accounts}
      initialAccountFreshness={accountFreshness}
      initialProperties={properties}
      initialVehicles={vehicles}
      initialPeople={people}
      initialAccountOwnerIds={ownerIdsByEntity(accountOwnersMap)}
      initialPropertyOwnerIds={ownerIdsByEntity(propertyOwnersMap)}
      initialVehicleOwnerIds={ownerIdsByEntity(vehicleOwnersMap)}
      initialPropertyLiabilityLinks={propertyLiabilityLinks}
      initialPropertyValuations={propertyValuations}
    />
  );
}
