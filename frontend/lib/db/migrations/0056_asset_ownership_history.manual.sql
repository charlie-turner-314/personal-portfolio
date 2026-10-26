-- Add complete dated ownership sets; retain legacy values and all resource IDs.
-- Invalid pre-existing mixed/partial splits fail closed instead of normalising
-- their financial meaning silently.
CREATE TABLE IF NOT EXISTS property_ownership_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
 effective_from date NOT NULL,
 share numeric(18,14) NOT NULL CHECK(share > 0 AND share <= 1),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(property_id,person_id,effective_from)
);
CREATE INDEX IF NOT EXISTS property_ownership_allocations_effective_idx
 ON property_ownership_allocations(property_id,effective_from);
CREATE TABLE IF NOT EXISTS vehicle_ownership_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
 effective_from date NOT NULL,
 share numeric(18,14) NOT NULL CHECK(share > 0 AND share <= 1),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(vehicle_id,person_id,effective_from)
);
CREATE INDEX IF NOT EXISTS vehicle_ownership_allocations_effective_idx
 ON vehicle_ownership_allocations(vehicle_id,effective_from);
DO $$ BEGIN
 IF EXISTS (SELECT property_id FROM property_owners GROUP BY property_id
   HAVING (count(share)>0 AND count(share)<count(*)) OR (count(share)=count(*) AND sum(share)<>1))
 OR EXISTS (SELECT vehicle_id FROM vehicle_owners GROUP BY vehicle_id
   HAVING (count(share)>0 AND count(share)<count(*)) OR (count(share)=count(*) AND sum(share)<>1)) THEN
  RAISE EXCEPTION 'Asset ownership needs repair: mixed or incomplete legacy splits. No allocations have been rewritten.';
 END IF;
END $$;
INSERT INTO people(user_id,name,kind)
 SELECT DISTINCT u.id,coalesce(nullif(btrim(u.name),''),'You'),'self' FROM users u
 WHERE (EXISTS(SELECT 1 FROM properties p WHERE p.user_id=u.id) OR EXISTS(SELECT 1 FROM vehicles v WHERE v.user_id=u.id))
 AND NOT EXISTS(SELECT 1 FROM people p WHERE p.user_id=u.id AND p.kind='self')
 ON CONFLICT DO NOTHING;
INSERT INTO property_ownership_allocations(property_id,person_id,effective_from,share)
 SELECT o.property_id,o.person_id,'0001-01-01',CASE WHEN o.share IS NOT NULL THEN o.share
 WHEN o.person_id=(SELECT max(peers.person_id::text)::uuid FROM property_owners peers WHERE peers.property_id=o.property_id)
 THEN 1-round(1.0/(SELECT count(*) FROM property_owners peers WHERE peers.property_id=o.property_id),14)*((SELECT count(*) FROM property_owners peers WHERE peers.property_id=o.property_id)-1)
 ELSE round(1.0/(SELECT count(*) FROM property_owners peers WHERE peers.property_id=o.property_id),14) END
 FROM property_owners o WHERE NOT EXISTS(SELECT 1 FROM property_ownership_allocations h WHERE h.property_id=o.property_id)
 ON CONFLICT DO NOTHING;
INSERT INTO property_ownership_allocations(property_id,person_id,effective_from,share)
 SELECT p.id,person.id,'0001-01-01',1 FROM properties p JOIN people person ON person.user_id=p.user_id AND person.kind='self'
 WHERE NOT EXISTS(SELECT 1 FROM property_ownership_allocations h WHERE h.property_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM property_owners legacy WHERE legacy.property_id=p.id)
 ON CONFLICT DO NOTHING;
INSERT INTO vehicle_ownership_allocations(vehicle_id,person_id,effective_from,share)
 SELECT o.vehicle_id,o.person_id,'0001-01-01',CASE WHEN o.share IS NOT NULL THEN o.share
 WHEN o.person_id=(SELECT max(peers.person_id::text)::uuid FROM vehicle_owners peers WHERE peers.vehicle_id=o.vehicle_id)
 THEN 1-round(1.0/(SELECT count(*) FROM vehicle_owners peers WHERE peers.vehicle_id=o.vehicle_id),14)*((SELECT count(*) FROM vehicle_owners peers WHERE peers.vehicle_id=o.vehicle_id)-1)
 ELSE round(1.0/(SELECT count(*) FROM vehicle_owners peers WHERE peers.vehicle_id=o.vehicle_id),14) END
 FROM vehicle_owners o WHERE NOT EXISTS(SELECT 1 FROM vehicle_ownership_allocations h WHERE h.vehicle_id=o.vehicle_id)
 ON CONFLICT DO NOTHING;
INSERT INTO vehicle_ownership_allocations(vehicle_id,person_id,effective_from,share)
 SELECT v.id,person.id,'0001-01-01',1 FROM vehicles v JOIN people person ON person.user_id=v.user_id AND person.kind='self'
 WHERE NOT EXISTS(SELECT 1 FROM vehicle_ownership_allocations h WHERE h.vehicle_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM vehicle_owners legacy WHERE legacy.vehicle_id=v.id)
 ON CONFLICT DO NOTHING;
