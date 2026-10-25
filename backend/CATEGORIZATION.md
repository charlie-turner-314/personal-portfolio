# Contextual transaction classification

Both single and batch classification use the same evidence retriever. The model
receives category names/descriptions, bounded category guidance, account context,
up to six relevant verified precedents (at most two per category), and up to four
possible transfer counterparts. Historical decisions are examples, not automatic
merchant-wide rules. Only explicitly supplied override rules bypass the model.

## Verification and existing history

Manual category changes/confirmations record `category_verified_at`. The import
path writes automatic predictions only to `category_system_id`. Existing rows
whose user and system categories are equal are **not** assumed reviewed: older
imports populated both fields automatically. Legacy manual differences, and
user assignments without a system category, remain eligible as precedents.

Migration `0048_category_verification.manual.sql` adds a nullable timestamp without
backfilling or changing any labels. Deploy the migration before the new code.

A user can explicitly attest that their current history has been reviewed and
freeze it as a private snapshot. This does not update transactions:

```sh
python backend/scripts/evaluate_categorizer.py export \
  --user-id USER_ID --trust-current-labels \
  --output .categorizer-lab/reviewed-history.json
```

The export runs in a read-only database transaction and creates a mode-600 file.
Without `--trust-current-labels`, only manual decisions are exported as examples.
All selected users, transactions and categories are scoped to the given user.
Do not commit these files. `.categorizer-lab/` is ignored.

To use a snapshot as runtime memory, set `CATEGORIZER_VERIFIED_SNAPSHOT` to its
absolute path. Each matcher validates its user ID, current effective labels and
classification metadata; changed/deleted records are discarded and newer manual
decisions take precedence. A routine bank refresh that only changes `updated_at`
does not invalidate a reviewed precedent. Container deployments must mount the file read-only
into the backend/worker processes that classify transactions and set the path in
those processes. A host environment path alone does not mount a file.

## Retrieval

The default retriever ranks up to 2,000 recent manual decisions, plus up to 2,000
current decisions from an explicitly configured snapshot. It combines IDF-weighted
text overlap, exact merchant matches, account, currency, amount proximity,
recency, and a small preference for corrected examples. It deduplicates repeated
precedents and preserves relevant competing labels. Neither account nor recency
alone can make an unrelated example eligible.

Set `CATEGORIZER_EMBEDDING_MODEL=text-embedding-3-small` to add semantic similarity.
Only description/merchant/counterparty text is embedded: labels, instructions and
account numbers are excluded. The process cache is bounded and keyed by user,
model and a hash of the text. Embeddings incur separate API usage; the first
retrieval can embed the eligible history in batches. A provider failure falls
back to text/metadata retrieval. Embedding token counts are separate from chat
token/cost metrics. No embedding prices are assumed.

Transfer candidates must be on another active owned account, have the same
currency and absolute amount, opposite direction, and be booked within three
days. Pending rows, existing transfer links, synthetic mirrors and explicit
non-transfer manual choices are excluded. Equal amount/time is supporting
evidence, not proof. Classification never creates links, mirrors, or changes
analytics inclusion. FX, fee differences, split transfers and delayed arrivals
beyond three days are not yet matched by this candidate query. The post-import
pipeline also reconsiders up to 50 earlier, genuinely uncategorised transactions
when the new import supplies a possible opposite-account counterpart. This
requires model access and never adds manual choices, existing system categories,
hidden/pending transactions or existing transfer links to the reconsideration set.

Target and evidence records resolve account IDs to names, account types and
currencies when enrichment is enabled. Account numbers and encrypted identifiers
are not included in these metadata mappings.

Target IDs are excluded from retrieved examples, including all targets across
batch boundaries. Metadata is JSON data. Requests are capped at ten transactions
when retrieval is enabled, and evidence at 6,000 characters per transaction;
global guidance has its own budget. Verbose counterpart records cannot crowd out
all precedents: the two kinds are interleaved and a summary discloses omitted or
limited candidates. One displayed candidate is not necessarily a unique match.
Response validation rejects unrequested indexes, duplicate indexes and unsupported
income/expense category mismatches. Missing or invalid confidence is left unknown.

Direction normally constrains the category type, but refunds/reversals can retain
the original expense/income category. An exception requires explicit refund/reversal
wording, or a relevant reviewed precedent with the same merchant, account and
cashflow direction. The same permission policy applies to single and batch calls.
It permits a contextual decision; it does not automatically copy the precedent.

`CATEGORIZER_CONTEXT_ENABLED` defaults to `false` for import/sync categorisation;
enabling the separate suggestion trial does not opt automatic assignments into
retrieval. Category/account
enrichment has the independent existing `CATEGORIZER_ENRICHED_PROMPT` flag. Model
selection still uses `CATEGORIZATION_LLM_MODEL` (default `gpt-4o-mini`).

## Prospective suggestion trial

The transaction details sheet has an opt-in, on-demand review panel. Apply pending
migrations, including `0047_category_confidence.manual.sql`,
`0048_category_verification.manual.sql` and
`0049_categorization_suggestions.manual.sql` before enabling it. Set the backend's
`CATEGORIZER_SUGGESTIONS_ENABLED=true`, `CATEGORIZER_PROVIDER=ollama` and
`CATEGORIZATION_LLM_MODEL=qwen3:8b`. The Ollama endpoint must be reachable from the
backend; an Ollama service on a Mac is not automatically reachable from a Pi.
The panel checks backend availability; no browser-side provider credentials or
extra frontend flag are required.

The default `CATEGORIZER_SUGGESTION_CONTEXT=examples_only` uses reviewed examples.
`contextual` additionally permits counterpart evidence for controlled trials.
Account roster and target metadata are held constant in these two policies.
The policy is saved with each suggestion. Both rollout flags are off by default.

Requesting or dismissing a suggestion does not change the transaction. Accepting
or correcting it sets the manual category and verification timestamp, preserving
the previous system category. This makes the user's decision available as a
future precedent. Neither action creates transfer links or changes analytics
inclusion. Pending rows, inactive accounts, existing manual categories and
confirmed transfer sources/mirrors are excluded. Reviews reject stale transaction
metadata, label changes and newly created transfer links; retries of a completed
review are idempotent. Every endpoint uses the signed authenticated user context.

The panel shows the actual retrieved examples, including previous system mistakes,
and possible counterpart records when that policy is enabled. It displays
**Needs review**, not a probability. Uncalibrated model scores are retained privately
for later evaluation but are omitted from the suggestion response/UI.

Explicit acceptance, correction and dismissal are recorded separately. The panel's
**Your trial results** disclosure and authenticated
`GET /api/categorization-suggestions/summary` expose outcome counts and elapsed
review duration. Time is client-reported wall time from display to action,
including pauses; it is not active effort. Acceptance among category reviews is
not verified accuracy. Edits elsewhere in the app are not retroactively inferred
to be acceptance or correction. Existing history supplies no prospective results;
real trial results start only when a user requests and reviews suggestions.
Requests that fail before producing a suggestion are not in these outcome counts.
Generation latency is stored separately on each suggestion.

## Evaluation and confidence

To isolate counterpart evidence, run `evaluate SNAPSHOT --ablation --run --output
PRIVATE_PATH`. To exercise transfer lookalikes, use `--split transfer --modes
without_retrieval examples_only contextual`. Other CLI arguments are unchanged.
The transfer challenge selects at most eight reviewed cases per stratum:
transfers with/without counterparts, non-transfers with counterparts, refund
language, transfer/payment language and ordinary controls. Absent strata are
reported as absent, not invented. Whole same-amount/currency events within three
days have their reviewed labels excluded from training, including other legs;
raw counterpart metadata remains available. Selection is fixed before inference.
This deliberately balanced challenge is not a population accuracy estimate.
It reports transfer precision/recall, false positives, abstentions and per-stratum
counts as well as exact-category accuracy. It tests classification, not whether
two rows should be permanently linked. Merchant and temporal holdouts remain
separate diagnostics. Do not tune prompts on these reported holdouts.

Prepare a retrospective holdout without calling any model:

```sh
python backend/scripts/evaluate_categorizer.py evaluate \
  .categorizer-lab/reviewed-history.json \
  --output .categorizer-lab/preparation.json --limit 50
```

Add `--run` to compare the same model with and without retrieved evidence, using
the configured `OPENAI_API_KEY`. Add `--semantic` for a third arm with embeddings.
Use `--split merchant` to hold out complete merchant groups. Reports include
coverage, accuracy among assigned/all transactions, familiar/unseen merchant
counts, score reliability bins, Brier error, ECE and accuracy at score thresholds.
The report also includes a top-retrieved-precedent baseline, which makes no LLM
calls and has no probability scores.
Private reports retain per-transaction predictions and retrieved evidence IDs for
review of disagreements; terminal output contains aggregates only. Paired live
comparisons count fixes and regressions and include a descriptive interval for
the accuracy change, bootstrapping whole merchant groups rather than assuming
repeated transactions are independent. This interval describes the benchmark;
it is not an individual prediction's confidence or a production guarantee.
Incomplete provider runs fail rather than being presented as a complete result.
All output files are created exclusively; use a new name for each run.

Holdout labels, instructions, verification metadata and system categories are
removed from targets. All holdout labels stay out of the precedent pool, including
unsampled holdouts. Counterpart metadata contains no labels. Temporal splitting
is retrospective: a snapshot verified today does not establish that those labels
were available on the historical booking dates. A future prospective replay
must use evidence availability/verification timestamps, not booking dates alone.

The comparison isolates retrieval: descriptions, category guidance, model and
batch size are the same in both arms. It does not recreate the entire old prompt.
The model's returned confidence is an **uncalibrated estimate**. Reliability
reports measure it; they do not calibrate it or prove individual predictions.
No automatic classifier training, self-labelling or online weight updates occur.
An independently calibrated classifier/reliability model remains a subsequent
experiment after sufficient held-out outcomes exist.

## Initial local measurement (2026-10-25)

A frozen, user-attested snapshot contained 348 reviewed examples. A time-based
holdout sampled 50 targets with 278 training precedents; all holdout labels were
excluded from retrieval. Qwen3 8B Q4_K_M, Ollama, temperature 0.1, seed 42,
thinking disabled and a 32768-token context produced:

| Method | Correct / all 50 | Predictions made |
| --- | --- | --- |
| LLM without retrieval | 18 | 49 |
| LLM with retrieved context | 33 | 49 |
| Top retrieved precedent alone | 34 | 40 |

Context fixed 15 baseline mistakes without regressing a previously correct
prediction. The descriptive merchant-cluster bootstrap interval for the accuracy
gain was approximately +10 to +50 percentage points. This is a small retrospective
sample from one user's history, not evidence of general accuracy or superiority
to a trained classifier. The comparison also does not establish performance of
OpenAI models. The contextual LLM's scores at least 95% were correct in 31 of 38
cases (82%); these scores must not be presented as calibrated probabilities.
Private case audits and actual model digest are retained in ignored
`.categorizer-lab/` artifacts. No real transaction labels were changed.

A second unchanged-prompt benchmark held out complete merchant-name groups:
266 training examples, 50 sampled targets across 19 groups. Without retrieval the
LLM got 32/50 correct; with context it got 34/50 (6 fixes, 4 regressions). The
descriptive accuracy-change interval was approximately -21 to +19 percentage
points, so this sample does not establish an improvement on unfamiliar merchants.
The nearest-precedent baseline got 3/50 correct and abstained on 36. These results
support testing a hybrid rather than assuming either retrieval copying or LLM
reasoning is universally better. A routing rule or calibrator must be developed
on separate data, not fitted to these reported holdouts.

The subsequent counterpart ablation on the same 50 temporal targets got 34/50
correct with examples alone versus 33/50 with full context (zero fixes, one
regression, one additional abstention). This supports the simpler examples-only
default for the review trial. It does not prove counterpart information is never
useful. The counterpart rendering budget may displace some precedent text; this
comparison measures the deployed rendering policy, not a causal information-only
effect with unlimited context.

The fixed transfer challenge contained 31 cases: 8 reviewed transfers with
counterparts, 8 without, 7 reviewed non-transfers with counterpart lookalikes and
8 ordinary non-transfer controls. Same-event label exclusion left 299 training
examples. There were no explicit refund/reimbursement-language strata in this
snapshot, so this run does not establish performance on those cases or on FX,
fees or split transfers.

| Method | Exact category correct | Transfers found / 16 | False transfers / 15 non-transfers |
| --- | --- | --- | --- |
| LLM without retrieval | 19/31 | 11 | 1 |
| Reviewed examples only | 18/31 | 13 | 2 |
| Examples plus counterpart context | 17/31 | 13 | 2 |

Both false transfers in the contextual arms occurred in the seven lookalikes.
Full context fixed no examples-only mistakes and regressed one exact-category
answer to abstention. This does not justify automatic transfer categorisation or
linking, nor adding counterparts to the default suggestion policy. This challenge
was intentionally stratified; its accuracy cannot be extrapolated to all
transactions. No prompts or retrieval thresholds were tuned to these results.

## Local model comparison (2026-10-25)

On the user's M1 Pro MacBook Pro (16 GB unified memory, 14-core GPU), three
Q4_K_M models were compared sequentially with the same frozen data, retrieved
examples, category guidance, temperature 0.1 and seed 42. The three diagnostic
sets contain 115 distinct transactions, with overlap between splits.

| Model | Recent correct / 50 | Merchant-held-out correct / 50 | Transfer challenge correct / 31 | Single-request median | Ollama allocation at 8K |
| --- | --- | --- | --- | --- | --- |
| Qwen3 8B | 34 | 30 | 18 | 15.0 s | 4.88 GiB |
| Qwen3.5 9B | 36 | 26 | 17 | 15.5 s | 4.58 GiB |
| Qwen3.5 4B | 23 | 11 | 13 | 8.6 s | 3.04 GiB |

Accuracy includes unassigned transactions in the denominator. Latency uses five
single-transaction requests at an 8192-token context; accuracy uses batches of up
to ten at 32768 tokens. Both newer models were downloaded and tested locally;
their full tags/digests, sampling defaults, hardware and runtime identity are in
the private comparison manifest. No provider settings or deployment were changed.

The original strict parser scored 34/30/18, 33/26/17 and 20/11/9 respectively.
Diagnostic replay found that newer models sometimes emitted `INDEX 10` instead
of `10`. The batch parser now accepts that explicit prefix, retaining requested-ID,
category, direction and duplicate checks. A literal `INDEX` with no number is
still rejected; answers are never assigned by output position.

The table includes follow-up compatibility rechecks of wholly unassigned batches,
with unchanged prompts/retrieval. A captured diagnostic response was rescored
where available; otherwise the whole failed batch was replayed once. All rows
in those batches were replaced, without choosing outcomes by correctness.
Original reports and timing measurements remain unchanged. This is a diagnostic
follow-up, not a claim that a fresh complete benchmark was rerun after the fix.
After rechecks, unassigned counts were 0/0/0, 0/1/2 and 11/20/11 respectively.

Qwen3 8B and Qwen3.5 9B each found 13/16 transfers and falsely called 2/15
non-transfers transfers. Qwen3.5 4B found 11/16 with zero false transfers, but
abstained/failed to identify rows much more often. The 9B recent-accuracy gain
was only two cases: four fixes and two regressions, with a descriptive clustered
bootstrap interval of approximately -5 to +16 percentage points. These results
do not establish a consistent quality advantage for 9B.

At 32K context, peak reported Ollama allocations were 7.14, 5.76 and 3.58 GiB;
no CPU offload was observed. All runs reached macOS pressure level 2 at some
point. Swap was already in use before testing; pressure/swap include other apps
and transient loading effects, so they cannot be attributed solely to a model.
Reported Ollama allocation is not a whole-system resident-memory measurement.

The practical recommendation is to retain **Qwen3 8B** for this categorisation
setup. The 9B model has mixed accuracy and similar latency; 4B trades too much
usable classification quality for speed. No model is claimed best in general,
and no confidence score became calibrated. A future prompt/schema change would
need a new controlled evaluation, not selective reuse of these outcomes.

The reusable runner is `backend/scripts/compare_ollama_categorizers.py`; private
per-split reports, raw diagnostic outputs and resource traces are under ignored
`.categorizer-lab/model-comparison-20261025/`.

## Development verification

For a sequential comparison of installed Ollama models on a Mac:

```sh
python backend/scripts/compare_ollama_categorizers.py PRIVATE_SNAPSHOT \
  --output-dir PRIVATE_NEW_DIRECTORY
```

The default candidates are Qwen3 8B, Qwen3.5 9B Q4_K_M and Qwen3.5 4B Q4_K_M.
Models must already be installed. The runner refuses to overwrite prior results
or evict a model already loaded by another task. It uses examples-only retrieval,
the same frozen temporal/merchant/transfer splits, temperature 0.1, seed 42 and
disabled thinking. Accuracy runs use the same 32768-token context and batches of
up to ten; five evenly spaced temporal targets then measure single-transaction
latency at 8192 tokens. Packaged model sampling defaults otherwise remain intact,
so this compares models under the app's settings rather than isolating weights
from every model-specific default. Each split is saved independently, privately.

Model digests, quantisation, provider version, source hashes and hardware are
recorded. Per-request token counts, prompt/decode/load durations and wall time
are retained without prompts in telemetry. Memory monitoring samples Ollama GPU
allocation and macOS system-wide pressure/swap every two seconds; those measures
are not interchangeable with model-only resident RAM. Only one candidate is
loaded at a time, and each is unloaded after its measurements. First interactive
request timing includes context reallocation; subsequent timings are also saved.

Prefer reliable category suggestions with fewer false transfer assignments; when
accuracy differences are inconclusive, prefer lower interactive latency and
memory use. These existing retrospective splits are model-selection diagnostics,
not a fresh prospective test set. Splits overlap and must not be pooled into a
claim of independent sample size. No prompt tuning or classifier training occurs.

For an already running local Ollama service, set `CATEGORIZER_PROVIDER=ollama`
and `CATEGORIZATION_LLM_MODEL=qwen3:8b`. The native transport disables thinking,
sets seed 42 and requests a 32768-token context explicitly. Configure the endpoint
with `CATEGORIZER_OLLAMA_BASE_URL` and request timeout with
`CATEGORIZER_OLLAMA_TIMEOUT` (180 seconds by default). A container must use an
endpoint reachable from that container; localhost refers to the container itself.
Truncated generations fail evaluation rather than count as completed responses.
Local calls report zero per-token API charge, which excludes electricity and
hardware costs. This transport currently supports chat, not semantic embeddings.
Use the actual installed model name; a local alias is not proof of model identity.

Use an isolated PostgreSQL database, never production, for tests:

```sh
python -m pytest backend/tests/test_categorization_context.py \
  backend/tests/test_categorization_evaluation.py \
  backend/tests/test_categorization_suggestions.py \
  backend/tests/test_category_matcher_prompt.py \
  backend/tests/test_category_confidence.py \
  backend/tests/test_category_matcher_llm_transfer.py \
  backend/tests/test_post_import_pipeline.py \
  backend/tests/test_account_sync_encryption.py \
  backend/tests/test_internal_transfer_service.py \
  backend/tests/test_mcp_update_category.py -q
```

These test retrieval, leakage, verification provenance, read-only snapshots,
transfer candidates, API fallbacks, output validation and pipeline preservation.
They do not establish an improvement in model accuracy; that requires the live
holdout comparison and review of disagreements with the trusted labels.

### Durable suggestion and feedback records

Migration 0050 stores a versioned private JSON record for each panel attempt:
original transaction/account metadata, category taxonomy/guidance, exact system
and user prompts, selected evidence, raw model output, parse outcomes, token
usage, provider response identifiers, Ollama digest/template/parameters/runtime
and explicit sampling/context options. Classifier source hashes identify the
implementation even when a build revision is unavailable. No credentials or
account numbers are copied. These payloads stay in owner-scoped database records,
not application logs or the public suggestion response.

An attempt is committed before inference. Completed assignments, explicit UNKNOWN
abstentions, malformed output, provider failures, and stale results are distinct;
a killed process can leave `generating`, which must not count as an abstention.
The cache requires the same target and configuration fingerprints, including
code, taxonomy, model identity and inference settings. Historical rows with no
provenance are marked `legacy`; missing history is never fabricated.

The client acknowledges first display through an owner-scoped, idempotent endpoint;
request time, first display, explicit review time, dismissal, and client-reported
elapsed time remain distinct. A successful display acknowledgement is evidence
of client rendering, not evidence the person read the suggestion.

A PostgreSQL trigger records manual category assignments/reassignments/clears and
verification changes from every writer (frontend SQL, REST, MCP, imports). It
captures previous and resulting manual categories, the contemporaneous system
category, category names/definitions, target metadata and verification times.
Panel assignments link to the originating suggestion. Outside-panel changes are
observations of manual assignment, not automatically classified as acceptance or
rejection of an earlier suggestion. System-only predictions create no manual
feedback. Records follow user/transaction deletion; category snapshots survive
renames and category foreign-key deletion. No retroactive manual history is
invented for changes made before installation.

This supports replay and future supervised evaluation, but manual labels are not
infallible ground truth. Panel acceptance is selected feedback, not an unbiased
accuracy estimate. Compare new methods against frozen held-out targets and
labels, excluding target/event labels from retrieval, and report coverage,
errors, and uncertainty. New inference methods must use a new configuration
fingerprint rather than reusing pending suggestions from an older method.
