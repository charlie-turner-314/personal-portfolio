import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ACCOUNT_TYPES, getAccountTypeLabel } from "@/lib/constants/account-types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

function AccountTypeSelector() {
  const [value, setValue] = useState("checking");

  return (
    <Select value={value} onValueChange={(next) => next && setValue(next)}>
      <SelectTrigger>
        <SelectValue>
          {(selected) => selected ? getAccountTypeLabel(selected) : "Select account type"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ACCOUNT_TYPES.map((type) => (
          <SelectItem key={type.value} value={type.value}>
            {type.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

describe("Select", () => {
  it("keeps the account type's user-facing label after a selection is persisted", () => {
    render(<AccountTypeSelector />);

    expect(screen.getByRole("combobox")).toHaveTextContent("Transaction Account");

    fireEvent.click(screen.getByRole("combobox"));
    const creditCard = screen.getByRole("option", { name: "Credit Card" });
    fireEvent.mouseMove(creditCard);
    fireEvent.click(creditCard);

    expect(screen.getByRole("combobox")).toHaveTextContent("Credit Card");
    expect(screen.getByRole("combobox")).not.toHaveTextContent("credit_card");
  });
});
