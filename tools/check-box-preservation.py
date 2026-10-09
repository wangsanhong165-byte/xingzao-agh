"""Independently inspect the three already-produced box STLs; no model/API calls."""
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh

root = Path(__file__).resolve().parent.parent
folder = root / "data" / "material-validation-v2"
comparison = json.loads((folder / "comparison.json").read_text(encoding="utf-8"))


def crossings(mesh, axis, point):
    """Line/triangle intersections without rtree or a geometry-generator callback."""
    projected = [index for index in range(3) if index != axis]
    triangles = mesh.triangles
    a = triangles[:, 0, projected]
    v0 = triangles[:, 1, projected] - a
    v1 = triangles[:, 2, projected] - a
    v2 = np.asarray(point) - a
    determinant = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    valid = np.abs(determinant) > 1e-10
    u = np.zeros(len(triangles))
    v = np.zeros(len(triangles))
    u[valid] = (v2[valid, 0] * v1[valid, 1] - v1[valid, 0] * v2[valid, 1]) / determinant[valid]
    v[valid] = (v0[valid, 0] * v2[valid, 1] - v2[valid, 0] * v0[valid, 1]) / determinant[valid]
    valid &= (u >= -1e-8) & (v >= -1e-8) & (u + v <= 1 + 1e-8)
    values = triangles[:, 0, axis] + u * (triangles[:, 1, axis] - triangles[:, 0, axis]) + v * (triangles[:, 2, axis] - triangles[:, 0, axis])
    return sorted(set(np.round(values[valid], 5).tolist()))


rows = []
for result in comparison["results"]:
    wall = result["wallMm"]
    source = root / result["stlPath"]
    data = source.read_bytes()
    mesh = trimesh.load_mesh(source, process=True)
    bottom = crossings(mesh, 2, [0.33, 0.37])
    hole_center = [crossings(mesh, 2, [x, 0]) for x in [-15, 15]]
    just_inside_hole = crossings(mesh, 2, [17.35, 0.1])
    just_outside_hole = crossings(mesh, 2, [17.65, 0.1])
    side = crossings(mesh, 0, [0.33, 10.37])
    checks = {
        "inputShaMatches": hashlib.sha256(data).hexdigest() == result["sha256"],
        "watertight": bool(mesh.is_watertight),
        "consistentWinding": bool(mesh.is_winding_consistent),
        "externalBoundsMatch": bool(np.allclose(mesh.bounds, [[-30, -20, 0], [30, 20, 25]], atol=1e-5)),
        "bottomThicknessAtSample2mm": len(bottom) == 2 and bool(np.allclose(bottom, [0, 2], atol=1e-5)),
        "holeCenterAndInsideSampleOpen": all(not values for values in hole_center) and not just_inside_hole,
        "outsideHoleSampleHasBottom": len(just_outside_hole) == 2 and bool(np.allclose(just_outside_hole, [0, 2], atol=1e-5)),
        "sideWallThicknessAtSampleMatches": len(side) == 4 and bool(np.allclose(side, [-30, -30 + wall, 30 - wall, 30], atol=1e-5)),
    }
    rows.append({"wallMm": wall, "checks": checks, "bottomRayZMm": bottom, "holeCenterRays": hole_center, "sideRayXMm": side, "allSampleChecksPassed": all(checks.values())})

report = {"scope": "independent STL bounds/topology and limited geometric ray samples; not exhaustive hole metrology, self-intersection, strength or physical-print validation", "rows": rows}
(folder / "independent-preservation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
raise SystemExit(0 if all(row["allSampleChecksPassed"] for row in rows) else 1)
