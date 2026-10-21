<!--
Keep this description proportional to the change.
Remove guidance comments before requesting review.
Do not report unrun checks as PASS.
-->

## Summary

<!-- What problem does this solve, and what changed? Focus on behavior and outcomes. -->

## Scope

<!-- State important boundaries, especially for migrations and architecture changes. -->

- Changed:
- Not changed / deferred:

## Related work

<!--
Link the owning issue when one exists. A small self-contained PR may have none.
Use "Closes #..." only when this PR satisfies the issue's full acceptance criteria.
Merging a PR does not automatically close a milestone or stage.
-->

Related: <!-- #issue / N/A -->

## Verification

<!--
Record the checks actually performed on the relevant code state.
Distinguish PASS, FAIL, NOT_RUN, NOT_VERIFIED and accepted limitations.
Use the repository's existing L1–L6 terminology where applicable.
Do not infer higher evidence tiers from test names or CI success.
-->

| Check / environment | Result | Evidence / limitations |
| --- | --- | --- |
| <!-- command or manual witness --> | <!-- PASS / FAIL / NOT_RUN --> | <!-- scope, output or link --> |

<!--
For user-visible changes, provide before/after frames or screenshots as appropriate.
For TSP changes, distinguish headless evidence from real Tern GUI verification.
For Host/Client changes, identify affected Direct / Remote paths and qualification coverage.
Omit these details when not applicable.
-->

## Risks and compatibility

<!--
Describe concrete remaining risks, compatibility impact and rollback when relevant.
Include ownership, lifecycle or security boundaries only when affected.
Write "N/A" if the change genuinely does not affect these areas.
-->

## Documentation

<!--
NO_REPO_DOC_UPDATE — no durable contract or reusable procedure changed.
DOC_UPDATED — name the single owning document and the changed contract.
OWNER_DECISION_REQUIRED — an accepted requirement conflicts with the docs policy.

Keep PR-specific evidence, progress and TODOs in Issues / PRs / CI, not docs/.
-->

Decision: `NO_REPO_DOC_UPDATE`

## Final checks

- [ ] The change stays within the stated scope; unrelated work is excluded.
- [ ] Verification results and remaining limitations are accurately reported.
- [ ] Related Issues are updated where applicable; PR completion and stage closure are distinguished.

<!-- Review acceptance does not authorize merge or release. -->
