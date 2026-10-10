# CAP-067 frontend / QA review

Reviewer: independent subagent `Kepler` (`01a0587e-60c2-7572-b429-bd58de22b4c6`)

## Initial findings

The read-only review found six MEDIUM findings:

1. Edit-form validation failures were silent and had no field accessibility state.
2. A stale active role query could overwrite a successful mutation cache update.
3. A clean edit form did not synchronize with an externally updated role projection.
4. Multiple custom-role forms reused indistinguishable labels and permission legends.
5. The client accepted an incomplete or duplicated permission catalog.
6. Some tests asserted values before the mutation was proven successful, omitted important error /
   empty / retry / cancellation states, and tested a mirrored route tree rather than the production
   role route.

## Resolution

All six findings were fixed in the working tree:

- edit validation now reports `VALIDATION_ERROR`, uses `required`, `aria-invalid`, and
  `aria-describedby`;
- role queries are cancelled before mutations and marked stale without an unsafe refetch after the
  server response updates the cache;
- clean edit forms synchronize to new server role props while dirty edits are preserved;
- role-specific labels and permission legends distinguish multiple forms;
- the role list contract requires all 21 declared permission keys exactly once;
- tests now prove the post-mutation success state, system read-only controls, edit validation,
  loading/error/empty/retry, mutation failure, delete cancellation, and the production router path.

Validation after the fixes: focused contracts/Web/router 446/446, full unit 1174/1174, lint,
typecheck, format, and build passed.
