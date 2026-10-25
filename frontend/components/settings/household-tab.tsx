"use client";
import { useState } from "react";
import { FinancialSharing } from "@/components/household/financial-sharing";
import { HouseholdAccess } from "@/components/household/household-access";
import { PeopleList } from "@/components/household/people-list";

type Person = {
  id: string;
  name: string;
  kind: string;
  color?: string | null;
  avatarUrl?: string | null;
};

export function HouseholdTab({ people, isOwner = true }: { people: Person[]; isOwner?: boolean }) {
  const [currentPeople, setCurrentPeople] = useState(people);
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Your household</h2>
        <p className="text-sm text-muted-foreground">
          Track who owns what — useful for joint accounts and household-level reports. People can stay as placeholders or accept an invitation to use their own login.
        </p>
      </div>
      <PeopleList initialPeople={people} readOnly={!isOwner} onPeopleChange={setCurrentPeople} />
      <FinancialSharing />
      <HouseholdAccess people={currentPeople} />
    </div>
  );
}
