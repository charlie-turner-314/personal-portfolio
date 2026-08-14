"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACCOUNT_TYPES,
  CURRENCIES,
  LIABILITY_REPAYMENT_FREQUENCIES,
  isLiabilityAccountType,
} from "@/lib/constants";
import { createAccount, createPocketAccount } from "@/lib/actions/accounts";
import { OwnersField, type OwnerValue } from "@/components/household/owners-field";

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

type Person = { id: string; name: string; kind: string; color?: string | null; avatarUrl?: string | null };

interface AccountFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  showCancel?: boolean;
  successMessage?: string;
  defaultCurrency?: string;
  defaultAccountType?: string;
  countryCode?: string | null;
}

export function AccountForm({
  onSuccess,
  onCancel,
  submitLabel = "Create Account",
  cancelLabel = "Cancel",
  showCancel = true,
  successMessage = "Account created successfully",
  defaultCurrency = "EUR",
  defaultAccountType = "",
  countryCode = null,
}: AccountFormProps) {
  const [isLoading, setIsLoading] = useState(false);

  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState(defaultAccountType);
  const [institution, setInstitution] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [initialBalance, setInitialBalance] = useState("");
  const [liabilityInterestRate, setLiabilityInterestRate] = useState("");
  const [liabilityRepaymentAmount, setLiabilityRepaymentAmount] = useState("");
  const [liabilityRepaymentFrequency, setLiabilityRepaymentFrequency] = useState("unknown");
  const [liabilityLoanTermMonths, setLiabilityLoanTermMonths] = useState("");
  const [liabilitySecured, setLiabilitySecured] = useState("unknown");
  const [isPocket, setIsPocket] = useState(false);
  const [iban, setIban] = useState("");

  // Ownership state
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [owners, setOwners] = useState<OwnerValue[]>([]);
  const [ownersError, setOwnersError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/people")
      .then((r) => r.json())
      .then((data: { people: Person[] }) => {
        setPeople(data.people);
        const self = data.people.find((p) => p.kind === "self");
        if (self) {
          setOwners([{ personId: self.id, share: null }]);
        }
      })
      .catch(() => {
        // Non-fatal: owners field will be empty; submit is still blocked until peopleLoaded.
      })
      .finally(() => setPeopleLoaded(true));
  }, []);

  const accountIsLiability = isLiabilityAccountType(accountType);
  const isAustralianProfile = countryCode === "AU";

  useEffect(() => {
    if (accountIsLiability && isPocket) {
      setIsPocket(false);
      setIban("");
    }
  }, [accountIsLiability, isPocket]);

  const resetForm = () => {
    setName("");
    setAccountType(defaultAccountType);
    setInstitution("");
    setCurrency(defaultCurrency);
    setInitialBalance("");
    setLiabilityInterestRate("");
    setLiabilityRepaymentAmount("");
    setLiabilityRepaymentFrequency("unknown");
    setLiabilityLoanTermMonths("");
    setLiabilitySecured("unknown");
    setIsPocket(false);
    setIban("");
    setOwnersError(null);
    // Re-seed owners to self
    const self = people.find((p) => p.kind === "self");
    setOwners(self ? [{ personId: self.id, share: null }] : []);
  };

  const validateOwners = (): boolean => {
    if (owners.length === 0) {
      setOwnersError("Select at least one owner.");
      return false;
    }
    const allNull = owners.every((o) => o.share === null);
    const allSet = owners.every((o) => o.share !== null);
    if (!allNull && !allSet) {
      setOwnersError("All owners must either split equally or specify shares.");
      return false;
    }
    if (allSet) {
      const sum = owners.reduce((acc, o) => acc + (o.share as number), 0);
      if (Math.abs(sum - 1) > 0.0001) {
        setOwnersError(`Shares must sum to 100% (currently ${Math.round(sum * 100)}%).`);
        return false;
      }
    }
    setOwnersError(null);
    return true;
  };

  const putOwners = async (entityId: string) => {
    try {
      const r = await fetch(`/api/owners/account/${entityId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owners }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "request failed");
        throw new Error(`Failed to save owners: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      toast.error((err as Error).message || "Account created, but failed to save ownership. You can update it later.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Please enter an account name");
      return;
    }
    if (!accountType) {
      toast.error("Please select an account type");
      return;
    }
    if (!currency) {
      toast.error("Please select a currency");
      return;
    }

    if (!peopleLoaded) {
      setOwnersError("Loading household data, please wait…");
      return;
    }
    if (people.length > 0 && !validateOwners()) return;

    const normalizedIban = iban.replace(/\s+/g, "").toUpperCase();
    if (isPocket) {
      if (!normalizedIban) {
        toast.error("Please enter an IBAN for the pocket account");
        return;
      }
      if (
        !IBAN_RE.test(normalizedIban)
        || normalizedIban.length < 15
        || normalizedIban.length > 34
      ) {
        toast.error("Please enter a valid IBAN");
        return;
      }
    }

    setIsLoading(true);

    try {
      const parseOptionalNumber = (value: string, label: string): number | undefined => {
        if (!value.trim()) return undefined;
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Please enter a valid ${label}`);
        }
        return parsed;
      };

      const balance = parseOptionalNumber(initialBalance, "balance") ?? 0;
      const interestRate = parseOptionalNumber(liabilityInterestRate, "interest rate");
      const repaymentAmount = parseOptionalNumber(liabilityRepaymentAmount, "repayment amount");
      const loanTermMonths = parseOptionalNumber(liabilityLoanTermMonths, "loan term");
      if (loanTermMonths !== undefined && (!Number.isInteger(loanTermMonths) || loanTermMonths <= 0)) {
        toast.error("Loan term must be a whole number of months");
        setIsLoading(false);
        return;
      }
      const result = isPocket
        ? await createPocketAccount({
            name: name.trim(),
            accountType,
            currency,
            startingBalance: balance,
            iban: normalizedIban,
          })
        : await createAccount({
            name: name.trim(),
            accountType,
            institution: institution.trim() || undefined,
            currency,
            startingBalance: balance,
            liabilityInterestRate: accountIsLiability ? interestRate : undefined,
            liabilityRepaymentAmount: accountIsLiability ? repaymentAmount : undefined,
            liabilityRepaymentFrequency: accountIsLiability && liabilityRepaymentFrequency !== "unknown"
              ? liabilityRepaymentFrequency
              : undefined,
            liabilityLoanTermMonths: accountIsLiability ? loanTermMonths : undefined,
            liabilitySecured: accountIsLiability && liabilitySecured !== "unknown"
              ? liabilitySecured === "secured"
              : undefined,
          });

      if (result.success) {
        // PUT owners after entity creation
        if (result.accountId) {
          await putOwners(result.accountId);
        }

        const backfilled =
          isPocket && "backfilledCount" in result && typeof result.backfilledCount === "number"
            ? result.backfilledCount
            : 0;
        const message = backfilled > 0
          ? `${successMessage} — ${backfilled} existing transfer${backfilled === 1 ? "" : "s"} linked`
          : successMessage;
        toast.success(message);
        resetForm();
        onSuccess?.();
      } else {
        toast.error(result.error || "Failed to create account");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    resetForm();
    onCancel?.();
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid gap-4 py-4">
        <div className="space-y-2">
          <Label htmlFor="account-name">Account Name</Label>
          <Input
            id="account-name"
            placeholder={isAustralianProfile ? "e.g., Everyday Account" : "e.g., Main Checking"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="account-type">Account Type</Label>
          <Select value={accountType} onValueChange={(v) => v && setAccountType(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select account type" />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!isPocket && (
          <div className="space-y-2">
            <Label htmlFor="account-institution">Institution (optional)</Label>
            <Input
              id="account-institution"
              placeholder={isAustralianProfile ? "e.g., CommBank, Westpac, NAB, ANZ" : "e.g., Bank of America"}
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="account-currency">Currency</Label>
          <Select value={currency} onValueChange={(v) => v && setCurrency(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select currency" />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((curr) => (
                <SelectItem key={curr.code} value={curr.code}>
                  {curr.code} - {curr.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="account-balance">
            {accountIsLiability
              ? "Opening Balance Owed (optional)"
              : "Initial Balance (optional)"}
          </Label>
          <Input
            id="account-balance"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={initialBalance}
            onChange={(e) => setInitialBalance(e.target.value)}
          />
        </div>

        {accountIsLiability && (
          <div className="grid gap-4 rounded border p-3">
            <div>
              <p className="text-sm font-medium">Loan details</p>
              <p className="text-xs text-muted-foreground">
                Leave anything unknown blank.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="liability-interest-rate">Interest Rate % (optional)</Label>
                <Input
                  id="liability-interest-rate"
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="6.49"
                  value={liabilityInterestRate}
                  onChange={(e) => setLiabilityInterestRate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="liability-repayment-amount">Repayment Amount (optional)</Label>
                <Input
                  id="liability-repayment-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={liabilityRepaymentAmount}
                  onChange={(e) => setLiabilityRepaymentAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="liability-repayment-frequency">Frequency (optional)</Label>
                <Select
                  value={liabilityRepaymentFrequency}
                  onValueChange={(v) => v && setLiabilityRepaymentFrequency(v)}
                >
                  <SelectTrigger id="liability-repayment-frequency">
                    <SelectValue placeholder="Select frequency" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unknown">Unknown</SelectItem>
                    {LIABILITY_REPAYMENT_FREQUENCIES.map((frequency) => (
                      <SelectItem key={frequency.value} value={frequency.value}>
                        {frequency.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="liability-loan-term">Loan Term Months (optional)</Label>
                <Input
                  id="liability-loan-term"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="360"
                  value={liabilityLoanTermMonths}
                  onChange={(e) => setLiabilityLoanTermMonths(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="liability-secured">Security (optional)</Label>
              <Select
                value={liabilitySecured}
                onValueChange={(v) => v && setLiabilitySecured(v)}
              >
                <SelectTrigger id="liability-secured">
                  <SelectValue placeholder="Select security type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unknown">Unknown</SelectItem>
                  <SelectItem value="secured">Secured</SelectItem>
                  <SelectItem value="unsecured">Unsecured</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {!accountIsLiability && !isAustralianProfile && (
          <div className="flex items-center justify-between rounded border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="is-pocket" className="cursor-pointer">
                Register as pocket account
              </Label>
              <p className="text-xs text-muted-foreground">
                Track a savings pocket by IBAN. Transfers from your synced accounts
                will be auto-detected and linked.
              </p>
            </div>
            <Switch
              id="is-pocket"
              checked={isPocket}
              onCheckedChange={setIsPocket}
            />
          </div>
        )}

        {isPocket && (
          <div className="space-y-2">
            <Label htmlFor="account-iban">IBAN</Label>
            <Input
              id="account-iban"
              placeholder="NL91 ABNA 0417 1643 00"
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
            />
            <p className="text-xs text-muted-foreground">
              Spaces are ignored. The IBAN is encrypted at rest and only used to
              match transfers from your synced accounts.
            </p>
          </div>
        )}

        {people.length > 0 && (
          <div className="space-y-2">
            <OwnersField
              people={people}
              value={owners}
              onChange={(next) => {
                setOwners(next);
                setOwnersError(null);
              }}
              disabled={isLoading}
            />
            {ownersError && (
              <p className="text-sm text-destructive">{ownersError}</p>
            )}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        {showCancel && (
          <Button type="button" variant="outline" onClick={handleCancel} disabled={isLoading}>
            {cancelLabel}
          </Button>
        )}
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "Creating..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
