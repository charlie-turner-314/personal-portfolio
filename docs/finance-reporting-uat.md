# Finance reporting UAT (PPF-53, PPF-55, PPF-56)

Run against the explicitly recorded, integrated develop revision in the isolated
release lab. Do not use the Pi, a production URL, or a restored user's account.
The test requires a loopback URL and a PostgreSQL container whose Compose project
label begins with `syllogic-release-lab-`.

From `frontend/`, after the lab is healthy:

```sh
E2E_BASE_URL=http://localhost:8091 \
FINANCE_UAT_DB_CONTAINER=<release-lab-postgres-container> \
./node_modules/.bin/playwright test e2e/finance-reporting.spec.ts --workers=1
```

Optional database overrides are `FINANCE_UAT_DB_USER` and `FINANCE_UAT_DB_NAME`;
defaults are the release lab's `financeuser` and `finance_db`. No credential file
needs to be printed or copied. The test uses Docker exec inside the isolated lab
container and creates a fresh randomly named synthetic user through registration.
It seeds only that new user's records and leaves the synthetic account for review.
It never resets demo data or changes an existing user.

## Expected browser results

| View | Cash | Gross assets | Debt shown | Net worth | Income | Spending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Whole household | 25,000 | 775,000 | -520,000 | 255,000 | 5,000 | 1,000 |
| UAT Alex | 15,000 | 390,000 | -312,000 | 78,000 | 3,000 | 600 |
| UAT Bea | 10,000 | 385,000 | -208,000 | 177,000 | 2,000 | 400 |

All values are AUD. The home is worth 750,000, owned equally. Cash and mortgage
ownership are 60% Alex and 40% Bea. Deliberately different shares catch incorrect
allocation of already-netted property equity. Debt must be deducted exactly once.
The two transactions are yesterday's income +5,000 and expense -1,000, both without
categories **or transaction types**, exercising direction fallback. Opening cash
is 21,000, making the current ledger and authoritative snapshot both 25,000.

The executable assertions cover actual displayed KPI amounts and scope labels,
visible person-button changes and reset, non-zero income/expense chart geometry,
Sankey links and uncategorised labels, and negative/red mortgage detail. Savings
rate is 80%. Screenshots of whole household and Alex's share plus synthetic fixture
identifiers are attached to Playwright results. HTTP success alone does not pass.

## Complementary release checks

The executable fixture focuses on rendering and reconciliation. Separately perform
the normal fresh-user account/property creation, ownership editor and transaction
CSV flows through the UI, because direct fixture seeding does not validate those
forms. In particular, confirm an uncategorised import is usable before any AI
categorisation completes, and verify transfer rows stay excluded. Run existing
Compose happy-path tests, the unit/PostgreSQL regression suites, and the release
lab's preserved-data comparison before promotion.
