# OAuth and account-switching status

## Automated coverage

The existing auth and desktop suites cover the owner-independent portions of account switching: PKCE state, fresh-login state, session persistence, logout invalidation, refresh-after-logout rejection, identity scoping, and renderer-facing account summary behavior. The R11 browser certification also verified login, restart, logout, and refresh invalidation.

The R12 authority and secret changes preserve the same boundaries: provider credentials are not copied into a different identity, and read-only planning/replanning roles cannot mutate account state.

## Remaining external test

`EXTERNAL_TEST_BLOCKER_SECOND_ACCOUNT` remains the correct classification. Only one authorized GitHub account is available in the current environment, so a real second-account switch cannot be honestly claimed. No test account was fabricated and no identity data was changed to simulate one.

## Required owner-run test when available

1. Sign in as account A and record only non-sensitive identity metadata.
2. Sign out and confirm the old access/refresh token is rejected.
3. Sign in as account B through a fresh PKCE flow.
4. Confirm avatar/email, GitHub connection, provider credential scope, local DB account ID, and server account ID all belong to B.
5. Restart the app and repeat the identity-scope assertion.
6. Sign back into A and confirm B’s cached state is not visible.
