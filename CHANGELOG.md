# Changelog

## beta-5

- Require valid provider signatures on every telephony webhook, including
  upgrades from installations that saved verification as disabled.
- Correct signature URL reconstruction through prefixed public hook paths.
- Authenticate media starts with short-lived, single-use random tickets carried
  in properly nested Stream Parameters; support queryless provider connections
  without starting an unauthenticated model session.
- Bind media events and disconnects to their owning socket, prevent replay and
  duplicate-call takeover, and time out unauthenticated sockets.
- Require the dashboard page token on sensitive APIs; validate call identifiers
  before filesystem access. Update setup guidance and verification diagnostics.
- Add an isolated authentication regression harness using synthetic credentials
  and a local model stub. No real phone calls or desktop tasks are performed.
