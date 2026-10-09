# Photo CAD AGH tools

This package adds four local tools to an AGH profile: read an uploaded PNG/JPEG as native image content, validate a supported geometry through the Photo CAD model API, compare Blender-rendered orthographic images, and commit one final JSON result to the isolated task directory.

The plugin has no external dependencies and does not load geometry files relative to its installed snapshot. The runner passes the random task directory and exact photo manifest through environment variables. The only service addresses are fixed loopback endpoints at `127.0.0.1:4317`.

## Agnes setup

The supported built-in Agnes provider is `agnes-ai` at its China gateway, `https://api.agnes-ai.cn/v1`. The model registry marks `agnes-3.0-flash`, `agnes-2.5-flash`, and `agnes-2.0-flash` as image capable. An international Agnes AI key belongs to a different gateway and is not interchangeable with the built-in China endpoint. Configure the international key through the isolated `local-dev` profile's wizard with Agnes's official international base URL, `https://apihub.agnes-ai.com/v1`; AGH tests the endpoint and returned model list before saving. The runner accepts only these two official Agnes endpoints, the `agnes-ai` provider, and one of the verified image models.

When an Agnes key is available, run `setup.ps1` to open AGH's official configuration wizard under `%USERPROFILE%\.agh-photo-cad`, using its built-in `local-dev` profile. Choose Agnes AI and an Agnes Flash model. Enter the key directly in the AGH wizard; this script never accepts it as an argument, prints it, or writes credentials itself. AGH stores the credential through its configuration API. The runner ignores the existing default `.agh` home.

The AGH provider registry uses the OpenAI-compatible chat API and its supported configuration API permits a per-account base URL override. Use the wizard's endpoint verification before saving an international account; a route failure does not trigger fallback to another provider.

## Package lifecycle

For package inspection and installation in a separate PowerShell window, first set `$env:AGH_HOME = Join-Path $env:USERPROFILE '.agh-photo-cad'`. Inspect this folder as a local AGH package, then install, review its declared tool capabilities, trust the inspected integrity, and enable it for the `local-dev` profile through the normal AGH package lifecycle. Installing source alone does not make its tools available. Review `index.mjs` before trusting it because trusted plugins execute with AGH's local plugin permissions.

The runner expects `photo_cad_read_photo`, `photo_cad_validate_geometry`, `photo_cad_render_views`, and `photo_cad_submit_result` to be enabled. Submission is refused unless every default sampled photo was read, the exact submitted spec passed real local mesh validation, and Blender returned valid comparison images.
