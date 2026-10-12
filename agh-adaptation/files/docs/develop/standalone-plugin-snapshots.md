# Standalone CLI installed plugin snapshots

The standalone CLI resolves explicit user-profile package references, but its Host assembly currently omits the immutable runtime snapshots that the daemon worker supplies. A trusted explicit package therefore fails with `snapshot-unavailable`; installing a package without an explicit reference leaves the standalone profile builtin-only.

The change follows the worker bootstrap: use PackageManager.runtimePluginSnapshots to read attested active pins and select only trusted snapshots with the exact profile, package ID, and integrity of enabled non-builtin profile references. Pass that selection and its official read-only source refresh to createHost. Do not load mutable install directories or synthesize snapshot identities. Package trust, approval, workspace policy, and existing request snapshots keep their current ownership.

Compatibility: no new required CLI flags, profile fields, or public protocol shapes. Builtin-only and injected Host test seams keep their previous behavior. Missing or mismatched snapshots still fail closed in Host. Tests cover accepted references, disabled packages, untrusted and stale snapshots, and undeclared packages.
