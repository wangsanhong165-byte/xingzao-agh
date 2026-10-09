# Virtual slicing tool

The slicer binary is intentionally excluded from Git and lives under the
worktree's ignored `data/tools/` directory. The module only looks for the
portable console executable there and uses a separate ignored `--datadir`, so
it does not read or alter the user's PrusaSlicer configuration.

## Tool source and license

- Tool: PrusaSlicer 2.9.6, stable release (not the 3.0 alpha).
- Official release: <https://github.com/prusa3d/PrusaSlicer/releases/tag/version_2.9.6>
- Windows portable archive: `PrusaSlicer-2.9.6.zip`
- Archive SHA-256: `5aaf22e42f95accecfa122d23a835911f289ecc2ff606db3e83d637ddcc0a209`
- License: GNU AGPL-3.0; see the release's official `LICENSE` file at
  <https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/LICENSE>.

The download came directly from the official GitHub release URL. This profile
and its results are virtual slicing estimates, not a match to or validation of
any real printer.

## Profile

`fdm-pla-04.ini` is a complete configuration exported by PrusaSlicer 2.9.6's
own `--save` action after loading the explicit virtual settings; it is loaded on
every slice using `--load`. It pins FDM, PLA, 0.4 mm nozzle, 0.2 mm layers, and
a 180 × 180 × 180 mm build volume. Temperature commands, skirts, brims, and
supports are disabled. STL models are centered at the virtual bed center by the
CLI `--center 90,90` option. The flags were checked against PrusaSlicer 2.9.6's
own `--help` output.

The only action used is G-code export. The application never opens a printer
connection or sends G-code to a device.
