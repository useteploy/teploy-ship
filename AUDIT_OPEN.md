# Open audit items

Unresolved findings for this repository from the ChatGPT-led audit series (2026-09-09 through 2026-09-11, passes 1-5; register: teploy-neutron-lullmail expanded audit). Every P0/P1 finding has been fixed and verified; the items below are the remaining P2/P3 tail plus one item needing validation. Fields are quoted from the audit register; line references point at the review commits listed per item where recorded.

Open items: 6 P2 (6 total)

## useteploy__teploy-ship-01 - P2 - Open

**File-backed delivery claims race within a single process**

- Kind: Confirmed from source
- Evidence: FileDeliveryLog.claim awaits #seen, mkdir and appendFile without a mutex or per-key reservation. Concurrent calls can both read an absent key before either appends it and both return true. The adjacent test checks sequential calls only; the documented cross-process caveat does not cover this single-process race.
- Impact: Duplicate webhook deliveries can both pass the replay ledger in file-backed development mode. Downstream task deduplication may reduce the resulting effects; its behavior was not reviewed. Nucleus-backed setNX is a separate path and is not implicated by this finding.
- Proposed fix: Serialize the read-and-claim operation with a process-wide store/per-key lock and a reservation held through persistence, or use a genuinely atomic store. Retain a clear restriction against unsupported multi-process file mode.
- Acceptance test: Run concurrent claims for the same source/id with barriers around the read step, including separate ledger objects pointed at the same directory. Exactly one should return true.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)

## useteploy__teploy-ship-02 - P2 - Open

**Delivery-ledger read failures are treated as unseen deliveries**

- Kind: Confirmed from source
- Evidence: #seen catches every readFile error and substitutes an empty string. That conflates an absent daily log with permissions, I/O, or other read failures. If appending remains possible, claim can record and accept a delivery despite being unable to inspect its existing history.
- Impact: Replay protection fails open under some local-storage faults. Other errors may also block appendFile, but that does not make it safe to silently classify all failed reads as an empty ledger.
- Proposed fix: Only interpret ENOENT as an empty day. Propagate other read errors and make receivers fail safely or explicitly queue for retry; expose ledger-health diagnostics.
- Acceptance test: Inject ENOENT, EACCES and EIO independently, including readable/writeable-permission asymmetry. Only ENOENT should allow an empty-history claim.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)

## useteploy__teploy-ship-04 - P2 - Open improvement

**Treat command regexes as advisory classification, not an enforcement boundary**

- Kind: Improvement
- Evidence: defaultApprovalPolicy and sandboxApprovalPolicy classify raw Bash/Python source with lists of regular expressions. Equivalent operations expressed through other commands, APIs, indirection, or argument forms are not necessarily recognized.
- Impact: A textual classifier cannot guarantee that every destructive or durable external action receives approval. This matters most for the trusted-local executor; it is not evidence of an escape from the separate sandbox implementation.
- Proposed fix: Keep mandatory filesystem/network/credential restrictions in the executor boundary and use explicit capability-scoped tools for durable external actions. Document the limits of heuristic classification and expand tests with semantically equivalent benign command forms.
- Acceptance test: Build a policy test corpus for equivalent argument spellings and API-based operations; verify enforcement through the executor does not depend solely on matching a particular source-code string.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)

## useteploy__teploy-ship-05 - P2 - Open

**Historical audit exports can change when current pricing changes**

- Kind: Source-confirmed
- Evidence: auditRow calls costUSD(meta.model, out.usage) while exporting run-completed events. Unless that usage already contains an explicit costUSD or unpriced marker, costUSD consults the current table and SHIP_MODEL_PRICING override. The audit comment claiming historical pricing is preserved is therefore too strong.
- Impact: Exporting the same recorded token usage before and after a pricing override can produce different historical cost figures. The diagnostic used synthetic rates only and reproduced a change from 1 to 2 for unchanged usage.
- Proposed fix: Persist the settled cost and pricing basis/version with the run when it completes. Export that value; label older rows without a historical rate as estimates rather than presenting recomputed figures as immutable actual cost.
- Acceptance test: Export an old run, change only pricing configuration, and export again. Settled historical cost must be stable; legacy estimates must carry an explicit estimated/repriced status.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)

## useteploy__teploy-ship-06 - P2 - Open

**Pricing overrides accept negative and non-finite rates**

- Kind: Source-confirmed
- Evidence: pricingOverrides tests only typeof value === number for rate fields. Negative numbers pass; JSON numeric overflow such as 1e309 becomes Infinity and also passes. costUSD multiplies these rates without a nonnegative/finite check.
- Impact: A malformed operator configuration can produce negative, infinite or NaN accounting results. The effect on a particular downstream budget comparison was not audited, so a proven spend-cap bypass is not claimed.
- Proposed fix: Require every rate to be finite and nonnegative, validate token counters similarly and surface a configuration error instead of silently accepting malformed values. Decide explicitly whether zero-priced models are allowed.
- Acceptance test: Cover negative input/output/cache rates, overflowing JSON numbers, missing values and normal zero/positive rates. All cost results used by enforcement should be finite and nonnegative.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)

## useteploy__teploy-ship-07 - P2 - Open improvement

**Offer a spreadsheet-safe audit CSV export mode**

- Kind: Improvement
- Evidence: csvCell escapes commas, quotes and line breaks but preserves a free-text task beginning with a spreadsheet formula marker. The benign string =1+1 remains unchanged in the included diagnostic.
- Impact: RFC-style CSV quoting protects column structure, not spreadsheet formula interpretation. An auditor opening untrusted task text in spreadsheet software may not see literal text. No spreadsheet execution or exploit was attempted.
- Proposed fix: Provide a documented spreadsheet-safe export that neutralizes formula-shaped text while preserving raw machine-readable JSON/CSV separately. Apply the policy to all free-text columns and document any reversible escaping.
- Acceptance test: Test harmless formula-shaped text, leading whitespace/control characters, ordinary punctuation and multilingual task names. Verify that safe-mode imports display literal strings in the supported spreadsheet applications.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)

