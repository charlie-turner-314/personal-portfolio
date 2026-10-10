"use client";

import { useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonAvatar } from "./person-avatar";

export type AccountOwnershipAllocation = { personId: string; share: number };

type Person = {
  id: string;
  name: string;
  kind: string;
  color?: string | null;
  avatarUrl?: string | null;
};

/**
 * Account ownership is deliberately always explicit.  Unlike the legacy
 * generic OwnersField, an allocation is a dated economic split and therefore
 * cannot rely on an implicit equal-share representation.
 */
export function AccountOwnershipAllocationField({
  people,
  value,
  effectiveFrom,
  onChange,
  onEffectiveFromChange,
  disabled,
}: {
  people: Person[];
  value: AccountOwnershipAllocation[];
  effectiveFrom: string;
  onChange: (next: AccountOwnershipAllocation[]) => void;
  onEffectiveFromChange: (date: string) => void;
  disabled?: boolean;
}) {
  const selectedIds = useMemo(() => new Set(value.map((owner) => owner.personId)), [value]);
  const total = value.reduce((sum, owner) => sum + owner.share, 0);
  const invalidTotal = value.length === 0 || Math.abs(total - 1) > 0.0001;

  function toggle(personId: string) {
    if (selectedIds.has(personId)) {
      onChange(value.filter((owner) => owner.personId !== personId));
      return;
    }
    const next = [...value, { personId, share: 0 }];
    // A newly-selected owner receives an equal split, which leaves the form in
    // a valid state until the user chooses a different ratio.
    const equal = 1 / next.length;
    onChange(next.map((owner) => ({ ...owner, share: equal })));
  }

  function setShare(personId: string, raw: string) {
    let share = Number(raw) / 100;
    if (!Number.isFinite(share) || share < 0) share = 0;
    if (share > 1) share = 1;
    onChange(value.map((owner) => owner.personId === personId ? { ...owner, share } : owner));
  }

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <div>
        <Label>Account ownership</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          This split attributes the account balance, income, and spending to household members.
        </p>
      </div>
      <div className="space-y-2">
        {people.map((person) => {
          const owner = value.find((item) => item.personId === person.id);
          const selected = !!owner;
          return (
            <div key={person.id} className="flex items-center gap-3">
              <Checkbox checked={selected} onCheckedChange={() => toggle(person.id)} />
              <PersonAvatar person={person} size={24} />
              <span className="flex-1 text-sm">{person.name}</span>
              {selected && (
                <div className="flex items-center gap-1">
                  <Input
                    aria-label={`${person.name} ownership percentage`}
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round((owner.share || 0) * 100)}
                    onChange={(event) => setShare(person.id, event.target.value)}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="space-y-1">
        <Label htmlFor="ownership-effective-from">Effective from</Label>
        <Input
          id="ownership-effective-from"
          type="date"
          value={effectiveFrom}
          onChange={(event) => onEffectiveFromChange(event.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          Later changes preserve prior reports by starting a new allocation on this date.
        </p>
      </div>
      {invalidTotal && (
        <p className="text-sm text-destructive">
          Select at least one person and make shares total 100% (currently {Math.round(total * 100)}%).
        </p>
      )}
    </fieldset>
  );
}
