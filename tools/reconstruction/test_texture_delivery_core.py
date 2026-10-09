import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest
import trimesh
from PIL import Image

from texture_delivery_core import (
    PROFILES,
    TextureDeliveryError,
    geometry_signature,
    load_source_mesh,
    transform_mesh_yup_metres,
    validate_job_paths,
    verify_delivery,
)

JOB = "12345678-1234-4234-8234-123456789abc"


def make_inputs(tmp_path):
    root = tmp_path / "data" / "texture" / "jobs"
    job = root / JOB
    job.mkdir(parents=True)
    source = job / "source.stl"
    source_mesh = trimesh.Trimesh(
        vertices=np.array([[1000, 0, 0], [0, 1000, 0], [0, 0, 1000]], dtype=np.float32),
        faces=np.array([[0, 1, 2]], dtype=np.int64), process=False,
    )
    source_mesh.export(source)
    reference = job / "reference.png"
    Image.new("RGB", (8, 8), "red").save(reference)
    out = job / "t01"
    out.mkdir()
    return root, job, source, reference, out


def write_glb(path, mesh, image=None, *, external_uri=False, missing_texture=False, missing_uv=False):
    if image is None:
        image = Image.new("RGB", (2048, 2048), "blue")
    uv = np.array([[0, 0], [1, 0], [0, 1]], dtype=np.float32)
    material = trimesh.visual.material.PBRMaterial() if missing_texture else trimesh.visual.material.PBRMaterial(baseColorTexture=image)
    mesh.visual = trimesh.visual.TextureVisuals(uv=None if missing_uv else uv, material=material)
    path.write_bytes(mesh.export(file_type="glb"))
    if external_uri:
        data = bytearray(path.read_bytes())
        json_len = int.from_bytes(data[12:16], "little")
        doc = json.loads(data[20:20 + json_len].decode("utf-8").rstrip(" \0"))
        doc["images"] = [{"uri": "https://example.invalid/texture.png"}]
        raw = json.dumps(doc, separators=(",", ":")).encode()
        raw += b" " * ((4 - len(raw) % 4) % 4)
        bin_start = 20 + json_len
        bin_len = int.from_bytes(data[bin_start:bin_start + 4], "little")
        bin_chunk = data[bin_start + 8:bin_start + 8 + bin_len]
        chunks = len(raw).to_bytes(4, "little") + b"JSON" + raw
        chunks += len(bin_chunk).to_bytes(4, "little") + b"BIN\x00" + bin_chunk
        path.write_bytes(b"glTF" + (2).to_bytes(4, "little") + (12 + len(chunks)).to_bytes(4, "little") + chunks)


def report_for(source, reference, glb, mesh, profile="standard"):
    expected = transform_mesh_yup_metres(mesh)
    prepared = source.parent / "t01" / "source-yup-metres.glb"
    expected.export(prepared, file_type="glb")
    signature = geometry_signature(expected.vertices, expected.faces)
    return {
        "status": "generated-awaiting-visual-review",
        "inputMeshSha256": hashlib.sha256(prepared.read_bytes()).hexdigest(),
        "inputImageSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "sourceStlSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "referenceImageSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "requestedProfile": profile,
        "expectedCoordinateTransform": "Z-up mm to Y-up metres [x,z,-y]/1000",
        "runId": "texture-12345678-1234-4234-8234-123456789abc-t01",
        "outputGlbSha256": hashlib.sha256(glb.read_bytes()).hexdigest(),
        "outputGlbBytes": glb.stat().st_size,
        "inputGeometrySignature": signature,
        "outputGeometrySignature": signature,
        "inputFaces": len(mesh.faces), "outputFaces": len(mesh.faces),
        "geometryPreservedAtFloat32": True,
        "peakAllocatedGpuMiB": 12.0,
        "elapsedSeconds": 1.0,
        "options": {"render_size": PROFILES[profile]["renderSize"], "texture_size": PROFILES[profile]["textureSize"],
                    "generatedViews": PROFILES[profile]["views"], "referenceViews": 1, "weightOffload": "model",
                    "paintOuterRequestedSteps": 30, "delightStepsPerReference": 0,
                    "delighting": "skipped explicitly for flat illustration"},
        "textureSizePixels": [PROFILES[profile]["textureSize"], PROFILES[profile]["textureSize"]],
        "sourceRevision": "f8db63096c8282cb27354314d896feba5ba6ff8a",
        "sourceRevisionExpected": "f8db63096c8282cb27354314d896feba5ba6ff8a",
        "sourceGitTreeExpected": "aa9c5e5d318d2ea2825de6c3ca76d6438f661322",
        "sourceVerification": {"revision": "f8db63096c8282cb27354314d896feba5ba6ff8a", "gitTree": "aa9c5e5d318d2ea2825de6c3ca76d6438f661322"},
        "modelRevision": "9cd649ba6913f7a852e3286bad86bfa9a2d83dcf",
    }


def write_result(out, source, reference, glb, mesh, profile="standard"):
    signature = geometry_signature(transform_mesh_yup_metres(mesh).vertices, transform_mesh_yup_metres(mesh).faces)
    size = glb.stat().st_size
    sha = hashlib.sha256(glb.read_bytes()).hexdigest()
    (out / "result.json").write_text(json.dumps({
        "success": True, "code": "OK", "attemptId": "t01", "profile": profile,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "glbSha256": sha, "glbBytes": size,
        "metrics": {"faces": len(mesh.faces), "textureSizePixels": [PROFILES[profile]["textureSize"]]*2,
                    "geometryPreservedAtFloat32": True, "peakAllocatedGpuMiB": 12.0, "elapsedSeconds": 1.0},
        "proof": {"inputGeometrySignature": signature, "outputGeometrySignature": signature,
                  "coordinateTransform": "Z-up mm to Y-up metres [x,z,-y]/1000",
                  "modelRevision": "9cd649ba6913f7a852e3286bad86bfa9a2d83dcf",
                  "sourceRevision": "f8db63096c8282cb27354314d896feba5ba6ff8a"},
    }))


def test_standard_profile_is_pinned():
    assert PROFILES["standard"] == {"renderSize": 1024, "textureSize": 2048, "views": 6}

def test_new_uv_recipe_is_checked_from_actual_exported_uvs(tmp_path):
    from texture_delivery_core import verify_uv_recipe
    mesh=trimesh.creation.box()
    uv=np.random.default_rng(27).random((len(mesh.vertices),2))
    mesh.visual=trimesh.visual.TextureVisuals(uv=uv,material=trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new('RGB',(16,16),'blue')))
    glb=tmp_path/'uv.glb';mesh.export(glb)
    imported=trimesh.load(glb,process=False,force='mesh')
    from texture_uv_scale import uv_quality_stats
    stats=uv_quality_stats(imported.faces,imported.visual.uv)
    report={'uvNormalization':{'recipe':'normalized-uv-working-copy-v1','workingLongestEdge':2,'geometryPreservedAtFloat32':True},'outputUvStatistics':stats}
    verify_uv_recipe(glb,report)
    changed={**report,'outputUvStatistics':{**stats,'zeroUVAreaFaces':stats['zeroUVAreaFaces']+1}}
    with pytest.raises(TextureDeliveryError,match='UV'):
        verify_uv_recipe(glb,changed)
    imported.visual.uv=np.zeros_like(imported.visual.uv);imported.export(glb)
    with pytest.raises(TextureDeliveryError,match='UV'):
        verify_uv_recipe(glb,report)

def test_old_uv_receipts_remain_file_checks_without_new_recipe_claim(tmp_path):
    from texture_delivery_core import verify_uv_recipe
    verify_uv_recipe(tmp_path/'no-need-to-read.glb',{})


def test_transform_is_exact_yup_metres_without_winding_change(tmp_path):
    _, _, source, _, _ = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    transformed = transform_mesh_yup_metres(mesh)
    np.testing.assert_allclose(transformed.vertices, mesh.vertices[:, [0, 2, 1]] * [0.001, 0.001, -0.001])
    assert transformed.faces.tolist() == mesh.faces.tolist()


def test_load_source_mesh_merges_exact_duplicate_stl_vertices_without_changing_geometry(tmp_path):
    path = tmp_path / "separate-triangle-vertices.stl"
    vertices = np.array([
        [0, 0, 0], [1000, 0, 0], [0, 1000, 0],
        [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0],
    ], dtype=np.float32)
    faces = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.int64)
    raw = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    before = geometry_signature(raw.vertices, raw.faces)
    raw.export(path)
    loaded = load_source_mesh(path)
    assert len(loaded.faces) == 2
    assert len(loaded.vertices) == 4
    assert geometry_signature(loaded.vertices, loaded.faces) == before
    converted = transform_mesh_yup_metres(loaded)
    prepared_glb = tmp_path / "source-yup-metres.glb"
    converted.export(prepared_glb, file_type="glb")
    roundtrip = load_source_mesh(prepared_glb)
    assert len(roundtrip.faces) == 2
    assert len(roundtrip.vertices) == 4
    assert geometry_signature(roundtrip.vertices, roundtrip.faces) == geometry_signature(converted.vertices, converted.faces)


def test_generate_accepts_only_its_precreated_request_file(tmp_path):
    from texture_worker import _validate_fresh_attempt

    out = tmp_path / JOB / "t01"
    out.mkdir(parents=True)
    request = out / "request-generate-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"
    request.write_text("{}")
    _validate_fresh_attempt(out, request, "generate")
    (out / "old-output.glb").write_bytes(b"stale")
    with pytest.raises(TextureDeliveryError, match="previous run"):
        _validate_fresh_attempt(out, request, "generate")


@pytest.mark.parametrize(("exception", "expected"), [
    ("GPU_BUSY", "TEXTURE_GPU_BUSY"),
    ("OutOfMemoryError", "TEXTURE_RESOURCE_FAILURE"),
    ("MemoryError", "TEXTURE_RESOURCE_FAILURE"),
    ("RuntimeError", None),
])
def test_only_explicit_cli_failures_trigger_busy_or_resource_codes(tmp_path, exception, expected):
    from texture_worker import _probe_failure_code

    work = tmp_path / "probe-work"
    work.mkdir()
    (work / "texture-probe.json").write_text(json.dumps({"status": "failed", "exception": exception}))
    assert _probe_failure_code(tmp_path) == expected


@pytest.mark.parametrize("payload", ["WRONG\n", "TEXTURE_START\nextra"])
def test_owned_start_requires_exact_token_before_reading_request(monkeypatch, capsys, payload):
    import texture_worker

    monkeypatch.setattr(texture_worker.sys, "stdin", io.StringIO(payload))
    monkeypatch.setattr(texture_worker, "_read_request", lambda _path: pytest.fail("request read before handshake"))
    code = texture_worker.main(["--owned-start", "--request", "unused.json"])
    output = json.loads(capsys.readouterr().out)
    assert code == 1
    assert output["success"] is False
    assert output["code"] == "TEXTURE_INPUT_INVALID"


def test_owned_start_exact_token_allows_worker_execution(monkeypatch, capsys):
    import texture_worker

    monkeypatch.setattr(texture_worker.sys, "stdin", io.StringIO("TEXTURE_START\n"))
    monkeypatch.setattr(texture_worker, "_read_request", lambda _path: {"mode": "verify"})
    monkeypatch.setattr(texture_worker, "execute", lambda _path: {"success": True, "code": "OK"})
    code = texture_worker.main(["--owned-start", "--request", "unused.json"])
    output = json.loads(capsys.readouterr().out)
    assert code == 0
    assert output["success"] is True


def test_without_owned_start_does_not_consume_stdin(monkeypatch, capsys):
    import texture_worker

    monkeypatch.setattr(texture_worker.sys, "stdin", io.StringIO("NOT_A_HANDSHAKE\n"))
    monkeypatch.setattr(texture_worker, "_read_request", lambda _path: {"mode": "verify"})
    monkeypatch.setattr(texture_worker, "execute", lambda _path: {"success": True, "code": "OK"})
    code = texture_worker.main(["--request", "unused.json"])
    output = json.loads(capsys.readouterr().out)
    assert code == 0
    assert output["success"] is True


def test_rejects_source_hash_mismatch(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    with pytest.raises(TextureDeliveryError, match="hash"):
        verify_delivery(root, JOB, "t01", source, reference, out, "0" * 64, hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


@pytest.mark.parametrize("mutation", ["move", "flip"])
def test_rejects_changed_or_flipped_geometry(tmp_path, mutation):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    transformed = transform_mesh_yup_metres(mesh)
    if mutation == "flip":
        transformed.faces = transformed.faces[:, [0, 2, 1]]
    else:
        transformed.vertices[0, 0] += 0.002
    write_glb(out / "textured.glb", transformed)
    report = report_for(source, reference, out / "textured.glb", mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    with pytest.raises(TextureDeliveryError):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_rejects_missing_texture_and_external_uri(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    transformed = transform_mesh_yup_metres(mesh)
    glb = out / "textured.glb"
    write_glb(glb, transformed, external_uri=True)
    report = report_for(source, reference, glb, mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, glb, mesh)
    with pytest.raises(TextureDeliveryError, match="external"):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_rejects_glb_without_embedded_texture(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    transformed = transform_mesh_yup_metres(mesh)
    write_glb(out / "textured.glb", transformed, missing_texture=True)
    report = report_for(source, reference, out / "textured.glb", mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    with pytest.raises(TextureDeliveryError, match="texture"):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_rejects_wrong_coordinate_frame(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    wrong_frame = mesh.copy()
    write_glb(out / "textured.glb", wrong_frame)
    report = report_for(source, reference, out / "textured.glb", mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    with pytest.raises(TextureDeliveryError):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_rejects_tampered_report(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    write_glb(out / "textured.glb", transform_mesh_yup_metres(mesh))
    report = report_for(source, reference, out / "textured.glb", mesh)
    report["inputGeometrySignature"] = "0" * 64
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    with pytest.raises(TextureDeliveryError, match="report"):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_rejects_glb_without_uv(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    write_glb(out / "textured.glb", transform_mesh_yup_metres(mesh), missing_uv=True)
    report = report_for(source, reference, out / "textured.glb", mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    with pytest.raises(TextureDeliveryError, match="UV"):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_rejects_paths_outside_job_and_symlinks(tmp_path, monkeypatch):
    root, _, source, reference, out = make_inputs(tmp_path)
    with pytest.raises(TextureDeliveryError, match="path"):
        validate_job_paths(root, JOB, "t01", tmp_path / "elsewhere.stl", reference, out)
    link = root / JOB / "linked.png"
    link.write_bytes(reference.read_bytes())
    import texture_delivery_core
    original = texture_delivery_core._is_reparse
    monkeypatch.setattr(texture_delivery_core, "_is_reparse", lambda path: path == link or original(path))
    with pytest.raises(TextureDeliveryError, match="link"):
        validate_job_paths(root, JOB, "t01", source, link, out)


def test_rejects_profile_size_mismatch(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    transformed = transform_mesh_yup_metres(mesh)
    write_glb(out / "textured.glb", transformed, Image.new("RGB", (512, 512), "blue"))
    report = report_for(source, reference, out / "textured.glb", mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    (out / "result.json").write_text(json.dumps({}))
    with pytest.raises(TextureDeliveryError, match="texture"):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")


def test_accepts_matching_embedded_delivery(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    transformed = transform_mesh_yup_metres(mesh)
    write_glb(out / "textured.glb", transformed)
    report = report_for(source, reference, out / "textured.glb", mesh)
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    checked = verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")
    assert checked["metrics"]["faces"] == len(mesh.faces)
    assert checked["proof"]["coordinateTransform"] == "Z-up mm to Y-up metres [x,z,-y]/1000"


def test_rejects_profile_with_mismatched_fixed_render_config(tmp_path):
    root, _, source, reference, out = make_inputs(tmp_path)
    mesh = trimesh.load(source, process=False, force="mesh")
    write_glb(out / "textured.glb", transform_mesh_yup_metres(mesh))
    report = report_for(source, reference, out / "textured.glb", mesh)
    report["options"]["generatedViews"] = 4
    (out / "texture-probe.json").write_text(json.dumps(report))
    write_result(out, source, reference, out / "textured.glb", mesh)
    with pytest.raises(TextureDeliveryError, match="profile configuration"):
        verify_delivery(root, JOB, "t01", source, reference, out, hashlib.sha256(source.read_bytes()).hexdigest(), hashlib.sha256(reference.read_bytes()).hexdigest(), "standard")
