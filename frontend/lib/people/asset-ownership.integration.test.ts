// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { propertyOwnershipShareSql, vehicleOwnershipShareSql } from "./ownership-sql";
import { propertyAccess } from "@/lib/household/account-access";

const url = process.env.HOUSEHOLD_MODEL_TEST_DATABASE_URL;
const admin = `asset-admin-${randomUUID()}`, member = `asset-member-${randomUUID()}`, destination = `asset-destination-${randomUUID()}`;
const self = randomUUID(), partner = randomUUID(), third = randomUUID(), newPartner = randomUUID();
const property = randomUUID(), vehicle = randomUUID();
let db: typeof import("@/lib/db").db;
let setOwners: typeof import("./mutations").setOwners;
let getOwners: typeof import("./queries").getOwners;

beforeAll(async () => {
  if (!url) return;
  if (process.env.HOUSEHOLD_TEST_ISOLATED !== "yes" || !new URL(url).pathname.includes("household_model_test")) throw new Error("Dedicated synthetic database required");
  process.env.DATABASE_URL = url;
  ({ db } = await import("@/lib/db"));
  ({ setOwners } = await import("./mutations"));
  ({ getOwners } = await import("./queries"));
  await db.insert(schema.users).values([admin,member,destination].map(id => ({ id, email: `${id}@example.test` })));
  await db.insert(schema.people).values([
    { id: self, userId: admin, kind: "self", name: "Admin" },
    { id: partner, userId: admin, linkedUserId: member, name: "Partner" },
    { id: third, userId: admin, name: "Third person" },
    { id: newPartner, userId: destination, linkedUserId: member, name: "Partner in new household" },
  ]);
  await db.insert(schema.householdMemberships).values({ memberUserId: member, ownerUserId: admin, personId: partner });
  await db.insert(schema.properties).values({ id: property, userId: admin, name: "Home", propertyType: "house", currency: "AUD", currentValue: "700000" });
  await db.insert(schema.vehicles).values({ id: vehicle, userId: admin, name: "Car", vehicleType: "car", currency: "AUD", currentValue: "30000" });
  await db.insert(schema.propertyOwners).values([self,partner,third].map(personId => ({ propertyId: property, personId, share: null })));
  await db.insert(schema.vehicleOwners).values([{ vehicleId: vehicle, personId: self, share: "0.6" }, { vehicleId: vehicle, personId: partner, share: "0.4" }]);
  await db.insert(schema.householdPropertyShares).values({ propertyId: property, grantedByUserId: admin, memberUserId: member });
});

afterAll(async () => {
  if (!url || !db) return;
  await db.delete(schema.propertyOwnershipAllocations).where(eq(schema.propertyOwnershipAllocations.propertyId, property));
  await db.delete(schema.vehicleOwnershipAllocations).where(eq(schema.vehicleOwnershipAllocations.vehicleId, vehicle));
  await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.memberUserId, member));
  await db.delete(schema.users).where(inArray(schema.users.id,[admin,member,destination]));
});

describe.skipIf(!url)("one effective-dated model for assets and liabilities", () => {
  it("backfills legacy meanings without rewriting legacy rows and gives equal thirds an exact total", async () => {
    const before = await db.select().from(schema.propertyOwners).where(eq(schema.propertyOwners.propertyId, property));
    const migration = readFileSync("lib/db/migrations/0056_asset_ownership_history.manual.sql", "utf8");
    const client = postgres(url!,{ prepare:false });
    try { await client.unsafe(migration); await client.unsafe(migration); } finally { await client.end(); }
    expect(await db.select().from(schema.propertyOwners).where(eq(schema.propertyOwners.propertyId, property))).toEqual(before);
    const [total] = await db.select({ total:sql<string>`sum(share)::text` }).from(schema.propertyOwnershipAllocations)
      .where(eq(schema.propertyOwnershipAllocations.propertyId,property));
    expect(Number(total.total)).toBe(1);
    expect(await getOwners("property",property,"2020-01-01")).toHaveLength(3);
  });

  it("uses complete dated sets in real single-table selections and keeps removed owners at zero", async () => {
    await setOwners({userId:admin,entityType:"property",entityId:property,effectiveFrom:"2026-07-01",owners:[{personId:self,share:.25},{personId:partner,share:.75}]});
    await setOwners({userId:admin,entityType:"vehicle",entityId:vehicle,effectiveFrom:"2026-07-01",owners:[{personId:self,share:.2},{personId:partner,share:.8}]});
    const [before] = await db.select({share:propertyOwnershipShareSql({userId:member},schema.properties.id,sql`'2026-06-30'::date`)}).from(schema.properties).where(eq(schema.properties.id,property));
    const [after] = await db.select({share:propertyOwnershipShareSql({userId:member},schema.properties.id,sql`'2026-07-01'::date`)}).from(schema.properties).where(eq(schema.properties.id,property));
    expect(Number(before.share)).toBeCloseTo(1/3,12);
    expect(Number(after.share)).toBe(.75);
    const [car] = await db.select({share:vehicleOwnershipShareSql({userId:member},schema.vehicles.id,sql`'2026-07-01'::date`)}).from(schema.vehicles).where(eq(schema.vehicles.id,vehicle));
    expect(Number(car.share)).toBe(.8);
    await setOwners({userId:admin,entityType:"property",entityId:property,effectiveFrom:"2030-01-01",owners:[{personId:partner,share:1}]});
    const [removed] = await db.select({share:propertyOwnershipShareSql(self,schema.properties.id,sql`'2030-01-01'::date`)}).from(schema.properties).where(eq(schema.properties.id,property));
    expect(Number(removed.share)).toBe(0);
    expect(await getOwners("property",property,"2026-07-01")).toHaveLength(2);
  });

  it("rejects unauthorized and partial snapshots atomically, while keeping ownership independent of membership", async () => {
    await expect(setOwners({userId:member,entityType:"property",entityId:property,effectiveFrom:"2026-07-01",owners:[{personId:partner,share:1}]})).rejects.toThrow(/custodian/);
    const before = await getOwners("property",property,"2026-07-01");
    await expect(setOwners({userId:admin,entityType:"property",entityId:property,effectiveFrom:"2026-07-01",owners:[{personId:self,share:.25},{personId:partner,share:.7499999999}]})).rejects.toThrow(/exactly/);
    expect(await getOwners("property",property,"2026-07-01")).toEqual(before);
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.memberUserId,member));
    await db.insert(schema.householdMemberships).values({memberUserId:member,ownerUserId:destination,personId:newPartner});
    const [retained] = await db.select({share:propertyOwnershipShareSql(newPartner,schema.properties.id,sql`'2026-07-01'::date`)}).from(schema.properties).where(eq(schema.properties.id,property));
    expect(Number(retained.share)).toBe(.75);
    const permitted = await db.select({id:schema.properties.id}).from(schema.properties).where(propertyAccess(schema.properties.id,member));
    expect(permitted.some(row=>row.id===property)).toBe(false);
    expect(await getOwners("property",property,"2026-07-01")).toEqual(before);
  });
});
