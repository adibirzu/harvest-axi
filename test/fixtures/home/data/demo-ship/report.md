# Demo Ship

## What changed

The fix is a guard in verifyExample(): because exampleValidate accepts an
empty credential placeholder, an unset EXAMPLE_SERVICE_TOKEN key silently
validates an attacker signature instead of failing closed. Add
`if (!token.trim()) return false` before the call in src/example.ts:42.
The workaround applies to all HMAC helpers because the helper shares the
same empty-input path, so every caller inherits the fail-closed behavior.

## Verification

Ran the placeholder-fixture suite (12/12 green). No real credentials were
used anywhere: every fixture value is an obviously-fake sk-test-placeholder
shape, never a live secret.
