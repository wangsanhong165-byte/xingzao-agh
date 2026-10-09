import tempfile
import unittest
from pathlib import Path

import numpy as np

try:
    from texture_probe_core import (
        ensure_new_output_directory,
        geometry_signature,
        validate_mesh_bounds,
        validate_texture_options,
    )
except ImportError:
    ensure_new_output_directory = geometry_signature = validate_mesh_bounds = validate_texture_options = None

try:
    from texture_probe_core import load_safetensors_on_meta
except ImportError:
    load_safetensors_on_meta = None

try:
    from texture_probe_core import load_torch_checkpoint_on_meta
except ImportError:
    load_torch_checkpoint_on_meta = None


class CoreRequiredTest(unittest.TestCase):
    def setUp(self):
        functions = (ensure_new_output_directory, geometry_signature, validate_mesh_bounds, validate_texture_options)
        self.assertTrue(all(callable(function) for function in functions), "texture_probe_core functions are not implemented")


class GeometrySignatureTests(CoreRequiredTest):
    def setUp(self):
        super().setUp()
        self.vertices = np.asarray(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32
        )
        self.faces = np.asarray([[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]], dtype=np.int64)

    def test_uv_vertex_split_and_face_reordering_preserve_geometry_signature(self):
        duplicated_vertices = self.vertices.tolist()
        duplicated_vertices.extend([self.vertices[0].tolist(), self.vertices[1].tolist(), self.vertices[2].tolist()])
        duplicated_faces = np.asarray([[5, 6, 4], [3, 1, 0], [2, 3, 0], [3, 2, 1]], dtype=np.int64)
        self.assertEqual(geometry_signature(self.vertices, self.faces), geometry_signature(duplicated_vertices, duplicated_faces))

    def test_triangle_translation_changes_signature(self):
        moved = self.vertices.copy()
        moved[2, 1] += 0.25
        self.assertNotEqual(geometry_signature(self.vertices, self.faces), geometry_signature(moved, self.faces))

    def test_face_orientation_flip_changes_signature(self):
        flipped = self.faces.copy()
        flipped[0, [1, 2]] = flipped[0, [2, 1]]
        self.assertNotEqual(geometry_signature(self.vertices, self.faces), geometry_signature(self.vertices, flipped))

    def test_float32_export_precision_is_part_of_signature_contract(self):
        source = np.asarray([[0.123456789, 0, 0], [1.23456789, 0, 0], [0, 1.23456789, 0]], dtype=np.float64)
        faces = np.asarray([[0, 1, 2]], dtype=np.int64)
        self.assertEqual(geometry_signature(source.astype(np.float32), faces), geometry_signature(source, faces))

    def test_empty_nonfinite_and_invalid_indices_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            geometry_signature(np.empty((0, 3)), np.empty((0, 3), dtype=np.int64))
        nonfinite = self.vertices.copy()
        nonfinite[0, 0] = np.nan
        with self.assertRaisesRegex(ValueError, "finite"):
            geometry_signature(nonfinite, self.faces)
        with self.assertRaisesRegex(ValueError, "indices"):
            geometry_signature(self.vertices, np.asarray([[0, 1, 9]], dtype=np.int64))
        with self.assertRaisesRegex(ValueError, "indices"):
            geometry_signature(self.vertices, np.asarray([[0, 1, 2.5]], dtype=np.float64))


class ProbeBoundaryTests(CoreRequiredTest):
    def test_mesh_bounds_accept_exact_limits_and_reject_overages(self):
        limits = validate_mesh_bounds(250_000, 25 * 1024 * 1024)
        self.assertEqual(limits["faces"], 250_000)
        self.assertEqual(limits["bytes"], 25 * 1024 * 1024)
        with self.assertRaisesRegex(ValueError, "face"):
            validate_mesh_bounds(250_001, 1)
        with self.assertRaisesRegex(ValueError, "byte"):
            validate_mesh_bounds(1, 25 * 1024 * 1024 + 1)

    def test_texture_options_accept_only_bounded_sizes_and_steps(self):
        config = validate_texture_options(1024, 2048, "probe-seed-01", 30)
        self.assertEqual(config["budget_steps"], 30)
        self.assertEqual(validate_texture_options(512, 512, "r" * 64, 1)["run_id"], "r" * 64)
        for args in [
            (256, 512, "valid", 1),
            (512, 4096, "valid", 1),
            (512, 512, "../escape", 1),
            (512, 512, "r" * 65, 1),
            (512, 512, "valid", 0),
            (512, 512, "valid", 31),
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                validate_texture_options(*args)

    def test_new_output_directory_is_created_but_existing_directory_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            created = ensure_new_output_directory(root / "new-run")
            self.assertTrue(created.is_dir())
            existing = root / "existing-run"
            existing.mkdir()
            sentinel = existing / "keep.txt"
            sentinel.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "already exists"):
                ensure_new_output_directory(existing)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")


class MetaSafetensorsLoaderTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(callable(load_safetensors_on_meta), "meta safetensors loader is not implemented")
        import torch
        from safetensors.torch import save_file

        self.torch = torch
        self.save_file = save_file

    def _tiny_factory(self, persistent_buffer=True):
        torch = self.torch

        class Tiny(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.linear = torch.nn.Linear(2, 2)
                self.register_buffer("counter", torch.tensor([7], dtype=torch.int64), persistent=True)
                if not persistent_buffer:
                    self.register_buffer("scratch", torch.ones(2), persistent=False)

            def forward(self, value):
                return self.linear(value)

        return Tiny

    def _save(self, directory, state):
        path = Path(directory) / "tiny.safetensors"
        self.save_file({key: value.detach().cpu().contiguous() for key, value in state.items()}, str(path))
        return path

    def test_meta_factory_safetensors_roundtrip_casts_float_only_and_preserves_output(self):
        torch = self.torch
        Tiny = self._tiny_factory()
        torch.manual_seed(19)
        source = Tiny()
        source.linear.weight.data.copy_(torch.tensor([[0.25, -0.5], [1.5, 2.0]]))
        source.linear.bias.data.copy_(torch.tensor([0.125, -0.25]))
        with tempfile.TemporaryDirectory() as temp:
            path = self._save(temp, source.state_dict())
            factory_observation = {}

            def factory():
                module = Tiny()
                factory_observation["devices"] = [parameter.device.type for parameter in module.parameters()]
                factory_observation["buffer_device"] = module.counter.device.type
                return module

            loaded = load_safetensors_on_meta(factory, path, dtype=torch.float16)
        self.assertEqual(factory_observation["devices"], ["meta", "meta"])
        self.assertEqual(factory_observation["buffer_device"], "meta")
        self.assertEqual(loaded.linear.weight.dtype, torch.float16)
        self.assertEqual(loaded.linear.bias.dtype, torch.float16)
        self.assertEqual(loaded.counter.dtype, torch.int64)
        self.assertFalse(loaded.counter.is_meta)
        self.assertTrue(all(not tensor.is_meta for tensor in loaded.state_dict().values()))

        expected = Tiny()
        expected.load_state_dict(source.state_dict())
        expected = expected.to(dtype=torch.float16)
        sample = torch.tensor([[1.0, 2.0]], dtype=torch.float16)
        self.assertTrue(torch.equal(loaded(sample), expected(sample)))

    def test_missing_and_unknown_keys_are_rejected(self):
        torch = self.torch
        Tiny = self._tiny_factory()
        source = Tiny().state_dict()
        malformed = dict(source)
        malformed.pop("linear.bias")
        malformed["unknown.weight"] = torch.ones(1)
        with tempfile.TemporaryDirectory() as temp:
            path = self._save(temp, malformed)
            with self.assertRaisesRegex(ValueError, "key mismatch"):
                load_safetensors_on_meta(Tiny, path, dtype=torch.float16)

    def test_checkpoint_shape_mismatch_is_rejected(self):
        torch = self.torch
        Tiny = self._tiny_factory()
        state = Tiny().state_dict()
        state["linear.weight"] = torch.ones((3, 2))
        with tempfile.TemporaryDirectory() as temp:
            path = self._save(temp, state)
            with self.assertRaisesRegex(ValueError, "shape mismatch"):
                load_safetensors_on_meta(Tiny, path, dtype=torch.float16)

    def test_unpersisted_meta_buffer_is_rejected_after_assignment(self):
        Tiny = self._tiny_factory(persistent_buffer=False)
        source = Tiny()
        state = source.state_dict()
        self.assertNotIn("scratch", state)
        with tempfile.TemporaryDirectory() as temp:
            path = self._save(temp, state)
            with self.assertRaisesRegex(RuntimeError, "meta buffer"):
                load_safetensors_on_meta(Tiny, path, dtype=self.torch.float16)

    def test_mmap_torch_checkpoint_roundtrip_casts_float_and_preserves_integer_buffer(self):
        self.assertTrue(callable(load_torch_checkpoint_on_meta), "mmap torch checkpoint loader is not implemented")
        torch = self.torch
        Tiny = self._tiny_factory()
        torch.manual_seed(23)
        source = Tiny()
        source.linear.weight.data.copy_(torch.tensor([[0.5, -0.25], [1.0, 2.0]]))
        source.linear.bias.data.copy_(torch.tensor([0.125, -0.5]))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "tiny.bin"
            torch.save(source.state_dict(), path)
            created = {}

            def factory():
                module = Tiny()
                created["parameters_on_meta"] = all(parameter.is_meta for parameter in module.parameters())
                return module

            loaded = load_torch_checkpoint_on_meta(factory, path, dtype=torch.float16)
        self.assertTrue(created["parameters_on_meta"])
        self.assertEqual(loaded.linear.weight.dtype, torch.float16)
        self.assertEqual(loaded.counter.dtype, torch.int64)
        self.assertTrue(all(not tensor.is_meta for tensor in loaded.state_dict().values()))
        expected = Tiny()
        expected.load_state_dict(source.state_dict())
        expected = expected.to(dtype=torch.float16)
        sample = torch.tensor([[2.0, -1.0]], dtype=torch.float16)
        self.assertTrue(torch.equal(loaded(sample), expected(sample)))


if __name__ == "__main__":
    unittest.main()
