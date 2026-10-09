import io
import numpy as np
import pytest
import trimesh
from feature_fixture import create_fixture


@pytest.mark.parametrize('diameter', [.07, .14, .3, .5, .8, 1])
def test_fixture_reimports_as_a_closed_part_with_a_real_pin_and_hole(diameter):
    mesh = create_fixture(diameter)
    restored = trimesh.load_mesh(io.BytesIO(mesh.export(file_type='stl')), file_type='stl', process=True)
    assert restored.is_watertight and restored.is_winding_consistent and restored.volume > 0
    assert np.allclose(restored.bounds, [[-10, -9, 0], [10, 9, 5]], atol=1e-5)
    assert restored.contains([[5, 0, 4], [-4, 0, 1.5], [0, 0, 1.5]]).tolist() == [True, False, True]


def test_fixture_rejects_out_of_budget_or_non_numeric_geometry():
    for value in [0, 2, True, '0.3', float('nan')]:
        with pytest.raises(ValueError):
            create_fixture(value)
