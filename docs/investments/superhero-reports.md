# Superhero report imports

The investment import supports three separate Superhero source contracts. Select **Superhero** as the provider and upload each report separately:

1. Transaction Statement CSV for buys and sells.
2. AUS or US Income Report CSV for cash dividends.
3. AMIT member annual statement PDF for final Australian tax components and cost-base adjustments.

Do not substitute the Full Portfolio Report for the AMIT statement. It does not contain the annual AMIT/AMMA tax fields.

## Income Report CSV

The parser recognizes the original metadata preamble, the `0` marker, and the table header below them. It trims header whitespace and excludes the `TOTAL` row.

The AUS contract maps payment date, ex date, security ticker, gross payment, net payment, withholding, franked amount, unfranked amount, and franking credit. The CSV labels withholding generically, so it is preserved as reported tax without guessing that it is TFN/ABN withholding. The AMIT PDF's explicitly labelled TFN/ABN amount is classified separately.

The US contract maps payment date, ex date, gross payment, net payment, and foreign withholding in USD. The available source fixture contains no payment rows, so a populated row is accepted only when `Security Description` is itself an unambiguous ticker. Other descriptions are rejected for review instead of guessing a symbol.

Each payment receives a deterministic provider record ID based on market, ticker, dates, and gross payment. Overlapping report windows therefore do not duplicate the same economic activity.

## AMIT PDF

The parser validates the Superhero AMIT title and reads each repeated four-page holding section. It extracts:

- fund name, ticker, and financial-year end;
- gross and net cash distribution;
- ATO-labelled franked, unfranked, franking-credit, foreign-income, foreign-tax, interest, and capital-gain values;
- TFN/ABN withholding;
- tax-deferred, tax-free, and other non-assessable components; and
- AMIT cost-base net increase and net decrease amounts.

ATO 18A (`Net capital gain`) and 18H (`Total current year capital gains`) are retained as separate, code-labelled components. The parser does not relabel 18A as a discounted gain or derive one figure from the other.

The annual statement is an aggregate, while the Income Report contains individual cash payments. Import the Income Report first. The AMIT record does not create another cash-income event: it offers all same-holding distributions in that financial year for explicit reconciliation, then enriches the selected event with the annual tax totals. This keeps cash totals unduplicated while retaining auditable statement provenance.

A cost-base increase is stored as a positive adjustment and a decrease as a negative adjustment. An adjustment that could reduce an open lot below zero stays in review because it may require separate CGT event E10 treatment.

## Privacy and audit behavior

Personal names, account identifiers, addresses, and original personalized filenames from the report preamble are not retained in normalized source records. The immutable source hash, provider record IDs, sanitized report type, row or page location, and extracted economic fields are retained for idempotency and audit. Imports remain reversible by batch.
