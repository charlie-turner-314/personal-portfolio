-- Effective-dated account ownership. Each effective_from is a complete
-- allocation snapshot, so historical reporting never changes when a split is
-- edited later.
CREATE TABLE IF NOT EXISTS "account_ownership_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "effective_from" date NOT NULL,
  "share" numeric(5, 4) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "account_ownership_allocations_account_person_effective_uq"
    UNIQUE("account_id", "person_id", "effective_from"),
  CONSTRAINT "account_ownership_allocations_share_range" CHECK ("share" > 0 AND "share" <= 1)
);

CREATE INDEX IF NOT EXISTS "idx_account_ownership_allocations_account_effective"
  ON "account_ownership_allocations" ("account_id", "effective_from");
CREATE INDEX IF NOT EXISTS "idx_account_ownership_allocations_person"
  ON "account_ownership_allocations" ("person_id");

-- All existing installations receive one stable baseline. Existing account
-- owners are preserved, including their equal-split representation (NULL).
INSERT INTO "people" ("user_id", "name", "kind")
SELECT u."id", COALESCE(NULLIF(BTRIM(u."name"), ''), 'You'), 'self'
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "people" p WHERE p."user_id" = u."id" AND p."kind" = 'self'
);

INSERT INTO "account_ownership_allocations" ("account_id", "person_id", "effective_from", "share")
SELECT ao."account_id",
       ao."person_id",
       DATE '1900-01-01',
       CASE
         -- Preserve valid explicit splits exactly.
         WHEN stats."null_count" = 0 AND stats."explicit_sum" = 1
           THEN ao."share"
         -- Legacy equal-split rows, mixed rows, and malformed totals all get
         -- a safe complete baseline rather than violating the new invariant.
         ELSE 1.0 / stats."owner_count"
       END
FROM "account_owners" ao
JOIN (
  SELECT "account_id",
         COUNT(*)::numeric AS "owner_count",
         COUNT(*) FILTER (WHERE "share" IS NULL) AS "null_count",
         COALESCE(SUM("share"), 0) AS "explicit_sum"
  FROM "account_owners"
  GROUP BY "account_id"
) stats ON stats."account_id" = ao."account_id"
ON CONFLICT ("account_id", "person_id", "effective_from") DO NOTHING;

-- Accounts created before the ownership feature may have no legacy owner.
INSERT INTO "account_ownership_allocations" ("account_id", "person_id", "effective_from", "share")
SELECT a."id", p."id", DATE '1900-01-01', 1.0
FROM "accounts" a
JOIN "people" p ON p."user_id" = a."user_id" AND p."kind" = 'self'
WHERE NOT EXISTS (
  SELECT 1 FROM "account_ownership_allocations" aoa WHERE aoa."account_id" = a."id"
)
ON CONFLICT ("account_id", "person_id", "effective_from") DO NOTHING;
