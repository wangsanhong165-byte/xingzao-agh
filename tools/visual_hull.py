"""Build a conservative voxel visual hull from the three fixed character panels.

This is ordinary silhouette geometry. It does not infer hidden detail or physical
measurements; height is normalized to 100 mm solely to give the mesh a usable scale.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np


DEFAULT_IMAGE = Path(
    r"C:\Users\LENOVO\AppData\Local\Temp\codex-clipboard-952bfa9c-6e94-4ad8-8cd7-238d2e386781.png"
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "data" / "character-test"
PANELS = {
    "front": (25, 28, 180, 265),
    "side": (187, 28, 327, 265),
    "back": (331, 28, 471, 265),
}
GRID = (128, 96, 192)  # nx, ny, nz; close to isotropic voxels for this drawing.


def extract_silhouette(image: np.ndarray, panel: tuple[int, int, int, int]) -> dict:
    x1, y1, x2, y2 = panel
    crop = image[y1:y2, x1:x2].copy()
    if crop.size == 0:
        raise ValueError(f"Panel crop is empty: {panel}")

    # Include dark outlines and saturated character colors. Neutral gray guide
    # dashes remain out even where they cross the feet or hair silhouette.
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    saturation = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[:, :, 1]
    mask = ((gray < 180) | (saturation > 25)).astype(np.uint8)
    # The strongest connected foreground is the character, including colored
    # appendages. Filling its external contour also closes white face/apron areas.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count <= 1:
        raise ValueError(f"No foreground subject found in panel {panel}")
    candidates = [(int(stats[i, cv2.CC_STAT_AREA]), i) for i in range(1, count)]
    area, subject_id = max(candidates)
    if area < crop.shape[0] * crop.shape[1] * 0.04:
        raise ValueError(f"Largest foreground component is too small in panel {panel}: {area}")

    subject = (labels == subject_id).astype(np.uint8)
    contours, _ = cv2.findContours(subject, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(subject)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    ys, xs = np.where(filled != 0)
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    tight = filled[by0:by1, bx0:bx1]
    return {
        "name": next((name for name, rect in PANELS.items() if rect == panel), "view"),
        "crop": crop,
        "mask": tight,
        "sourceRect": (x1 + bx0, y1 + by0, x1 + bx1, y1 + by1),
        "bboxPixels": [bx0, by0, bx1 - bx0, by1 - by0],
        "componentAreaPx": area,
        "filledAreaPx": int(np.count_nonzero(filled)),
        "discardedComponents": len(candidates) - 1,
    }


def resize_height(mask: np.ndarray, target_height: int) -> np.ndarray:
    width = max(1, int(round(mask.shape[1] * target_height / mask.shape[0])))
    resized = cv2.resize(mask, (width, target_height), interpolation=cv2.INTER_NEAREST)
    return (resized != 0).astype(np.uint8)


def centered_canvas(mask: np.ndarray, width: int) -> np.ndarray:
    if mask.shape[1] > width:
        left = (mask.shape[1] - width) // 2
        return mask[:, left : left + width]
    result = np.zeros((mask.shape[0], width), dtype=np.uint8)
    left = (width - mask.shape[1]) // 2
    result[:, left : left + mask.shape[1]] = mask
    return result


def scale_to_grid(mask: np.ndarray, target_width: int, target_height: int) -> np.ndarray:
    resized = cv2.resize(mask, (target_width, target_height), interpolation=cv2.INTER_NEAREST)
    return (resized != 0).astype(np.uint8)


def map_mask_to_common_width(mask: np.ndarray, voxel_width: int, physical_width: float, max_width: float) -> np.ndarray:
    # physical_width / max_width gives the view's undistorted span on the shared X/Y axis.
    target_width = max(1, int(round(voxel_width * physical_width / max_width)))
    scaled = scale_to_grid(mask, target_width, mask.shape[0])
    return centered_canvas(scaled, voxel_width)


def color_at(view: dict, u_fraction: float, z_fraction: float) -> list[float]:
    x1, y1, x2, y2 = view["sourceRect"]
    px = min(max(int(round(x1 + u_fraction * (x2 - x1 - 1))), 0), view["imageWidth"] - 1)
    py = min(max(int(round(y1 + z_fraction * (y2 - y1 - 1))), 0), view["imageHeight"] - 1)
    bgr = view["image"][py, px]
    return [round(float(channel) / 255.0, 4) for channel in (bgr[2], bgr[1], bgr[0])]


def silhouette_contains(view: dict, u_fraction: float, z_fraction: float) -> bool:
    mask = view["mask"]
    px = min(max(int(round(u_fraction * (mask.shape[1] - 1))), 0), mask.shape[1] - 1)
    py = min(max(int(round(z_fraction * (mask.shape[0] - 1))), 0), mask.shape[0] - 1)
    return bool(mask[py, px])


def expose_faces(occupied: np.ndarray, width: float, depth: float, height: float, views: dict) -> tuple[list, list, list]:
    nz, nx, ny = occupied.shape
    sx, sy, sz = width / nx, depth / ny, height / nz
    vertices: list[list[float]] = []
    faces: list[list[int]] = []
    face_colors: list[list[float]] = []
    vertex_index: dict[tuple[int, int, int], int] = {}

    def add_vertex(point: tuple[int, int, int]) -> int:
        index = vertex_index.get(point)
        if index is None:
            ix, iy, iz = point
            index = len(vertices)
            vertex_index[point] = index
            vertices.append([
                round(ix * sx - width / 2, 6),
                round(iy * sy - depth / 2, 6),
                round(iz * sz, 6),
            ])
        return index

    directions = [
        ("x-", (0, -1, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
        ("x+", (0, 1, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
        ("y-", (0, 0, -1), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
        ("y+", (0, 0, 1), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
        ("z-", (-1, 0, 0), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
        ("z+", (1, 0, 0), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
    ]

    def nearest_color(kind: str, x_mm: float, y_mm: float, z_mm: float, ix: int, iy: int, iz: int) -> list[float]:
        z_fraction = 1.0 - z_mm / height
        if kind == "x-" or kind == "x+":
            y_fraction = min(max(y_mm / depth + 0.5, 0.0), 1.0)
            return color_at(views["side"], y_fraction, z_fraction)
        if kind == "y-" or kind == "y+":
            primary_name = "front" if kind == "y-" else "back"
            fallback_name = "back" if primary_name == "front" else "front"
            primary = views[primary_name]
            fallback = views[fallback_name]
            primary_u = min(max(x_mm / primary["widthMm"] + 0.5, 0.0), 1.0)
            fallback_u = min(max(x_mm / fallback["widthMm"] + 0.5, 0.0), 1.0)
            if silhouette_contains(primary, primary_u, z_fraction):
                return color_at(primary, primary_u, z_fraction)
            if silhouette_contains(fallback, fallback_u, z_fraction):
                return color_at(fallback, fallback_u, z_fraction)
            y_fraction = min(max(y_mm / depth + 0.5, 0.0), 1.0)
            return color_at(views["side"], y_fraction, z_fraction)
        # A top/bottom voxel face is constrained by whichever vertical silhouette
        # changes at that location. Prefer that source projection for its color.
        fx = min(max(int((x_mm / width + 0.5) * nx), 0), nx - 1)
        syi = min(max(int((y_mm / depth + 0.5) * ny), 0), ny - 1)
        zi = min(max(int(iz), 0), nz - 1)
        front_edge = bool(views["frontGrid"][zi, fx])
        side_edge = bool(views["sideGrid"][zi, syi])
        front = views["front"]
        back = views["back"]
        front_u = min(max(x_mm / front["widthMm"] + 0.5, 0.0), 1.0)
        back_u = min(max(x_mm / back["widthMm"] + 0.5, 0.0), 1.0)
        front_edge = silhouette_contains(front, front_u, z_fraction)
        back_edge = silhouette_contains(back, back_u, z_fraction)
        if front_edge:
            return color_at(front, front_u, z_fraction)
        if back_edge:
            return color_at(back, back_u, z_fraction)
        if not side_edge:
            return color_at(front, front_u, z_fraction)
        y_fraction = min(max(y_mm / depth + 0.5, 0.0), 1.0)
        return color_at(views["side"], y_fraction, z_fraction)

    for kind, (dz, dx, dy), corners in directions:
        neighbor = np.zeros_like(occupied)
        z_src = slice(max(0, -dz), min(nz, nz - dz))
        x_src = slice(max(0, -dx), min(nx, nx - dx))
        y_src = slice(max(0, -dy), min(ny, ny - dy))
        z_dst = slice(max(0, dz), min(nz, nz + dz))
        x_dst = slice(max(0, dx), min(nx, nx + dx))
        y_dst = slice(max(0, dy), min(ny, ny + dy))
        neighbor[z_src, x_src, y_src] = occupied[z_dst, x_dst, y_dst]
        boundary = np.argwhere(occupied & ~neighbor)
        for iz, ix, iy in boundary:
            face = []
            for ox, oy, oz in corners:
                face.append(add_vertex((int(ix + ox), int(iy + oy), int(iz + oz))))
            faces.append(face)
            center_x = (ix + (0.5 if kind in ("x-", "x+") else 0.5)) * sx - width / 2
            center_y = (iy + (0.5 if kind in ("y-", "y+") else 0.5)) * sy - depth / 2
            center_z = (iz + (0.5 if kind in ("z-", "z+") else 0.5)) * sz
            face_colors.append(nearest_color(kind, center_x, center_y, center_z, int(ix), int(iy), int(iz)))

    return vertices, faces, face_colors


def make_mask_diagnostic(image: np.ndarray, views: dict, front_grid: np.ndarray, side_grid: np.ndarray, output: Path) -> None:
    panel_width, row_height, header_height = 320, 270, 26
    body_width, body_height = panel_width - 16, row_height - header_height - 12
    canvas = np.full((row_height * 3, panel_width * 3, 3), 248, dtype=np.uint8)

    def fit(source: np.ndarray, is_mask: bool = False) -> np.ndarray:
        if source.ndim == 2:
            source = cv2.cvtColor(source, cv2.COLOR_GRAY2BGR)
        scale = min(body_width / source.shape[1], body_height / source.shape[0])
        size = (max(1, int(round(source.shape[1] * scale))), max(1, int(round(source.shape[0] * scale))))
        rendered = cv2.resize(source, size, interpolation=cv2.INTER_NEAREST if is_mask else cv2.INTER_AREA)
        cell = np.full((body_height, body_width, 3), 248, dtype=np.uint8)
        y = (body_height - size[1]) // 2
        x = (body_width - size[0]) // 2
        cell[y : y + size[1], x : x + size[0]] = rendered
        return cell

    cells = []
    for name in ("front", "side", "back"):
        x1, y1, x2, y2 = PANELS[name]
        cells.append((f"{name}: source crop", image[y1:y2, x1:x2], False))
    for name in ("front", "side", "back"):
        cells.append((f"{name}: filled subject mask", views[name]["originalMask"] * 255, True))
    cells.extend([
        ("front/back union: common XZ", front_grid[::-1, :] * 255, True),
        ("side: common YZ", side_grid[::-1, :] * 255, True),
        ("visual hull uses their intersection", np.zeros((1, 1), dtype=np.uint8), True),
    ])
    for index, (label, source, is_mask) in enumerate(cells):
        row, column = divmod(index, 3)
        x0, y0 = column * panel_width, row * row_height
        cv2.putText(canvas, label, (x0 + 8, y0 + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (20, 20, 20), 1, cv2.LINE_AA)
        body = fit(source, is_mask)
        canvas[y0 + header_height : y0 + header_height + body_height, x0 + 8 : x0 + 8 + body_width] = body
    ok, encoded = cv2.imencode(".png", canvas)
    if not ok:
        raise RuntimeError("Could not encode masks.png")
    output.write_bytes(encoded.tobytes())


def build(image_path: Path, output_dir: Path) -> dict:
    started = time.perf_counter()
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(f"Cannot read input image: {image_path}")
    image_height, image_width = image.shape[:2]
    for panel in PANELS.values():
        if panel[2] > image_width or panel[3] > image_height:
            raise ValueError(f"Expected image at least 471x265 pixels; got {image_width}x{image_height}")

    views = {name: extract_silhouette(image, panel) for name, panel in PANELS.items()}
    for view in views.values():
        panel = PANELS[view["name"]]
        view["image"] = image
        view["imageWidth"] = image_width
        view["imageHeight"] = image_height
        view["originalMask"] = np.zeros((panel[3] - panel[1], panel[2] - panel[0]), dtype=np.uint8)
        x1, y1, x2, y2 = PANELS[view["name"]]
        sx1, sy1, sx2, sy2 = view["sourceRect"]
        bx0, by0 = sx1 - x1, sy1 - y1
        view["originalMask"][by0 : by0 + view["mask"].shape[0], bx0 : bx0 + view["mask"].shape[1]] = view["mask"]

    nx, ny, nz = GRID
    physical_height = 100.0
    canonical = {name: resize_height(view["mask"], nz) for name, view in views.items()}
    front_mm_width = canonical["front"].shape[1] * physical_height / nz
    back_mm_width = canonical["back"].shape[1] * physical_height / nz
    side_mm_depth = canonical["side"].shape[1] * physical_height / nz
    for name, span in (("front", front_mm_width), ("back", back_mm_width), ("side", side_mm_depth)):
        views[name]["widthMm"] = span
    physical_width = max(front_mm_width, back_mm_width)
    physical_depth = side_mm_depth

    front_on_grid = map_mask_to_common_width(canonical["front"], nx, front_mm_width, physical_width)
    back_on_grid = map_mask_to_common_width(canonical["back"], nx, back_mm_width, physical_width)
    front_back_xz = np.maximum(front_on_grid, back_on_grid)
    side_yz = map_mask_to_common_width(canonical["side"], ny, physical_depth, physical_depth)
    front_grid = front_back_xz[::-1, :].copy()
    side_grid = side_yz[::-1, :].copy()

    occupied = (front_grid[:, :, None] != 0) & (side_grid[:, None, :] != 0)
    occupied = occupied.astype(np.uint8)
    voxel_count = int(np.count_nonzero(occupied))
    if voxel_count == 0:
        raise ValueError("The front/back and side silhouettes do not intersect")

    views["frontGrid"] = front_grid
    views["sideGrid"] = side_grid
    vertices, faces, face_colors = expose_faces(occupied, physical_width, physical_depth, physical_height, views)
    edge_counts = Counter(
        tuple(sorted((face[index], face[(index + 1) % 4])))
        for face in faces
        for index in range(4)
    )
    boundary_edges = sum(count == 1 for count in edge_counts.values())
    nonmanifold_edges = sum(count != 2 for count in edge_counts.values())
    if nonmanifold_edges:
        raise RuntimeError(f"Voxel boundary mesh is not closed: {boundary_edges} boundary edges, {nonmanifold_edges} non-manifold edges")

    output_dir.mkdir(parents=True, exist_ok=True)
    hull_path = output_dir / "hull.json"
    metrics = {
        "inputImage": str(image_path),
        "imagePixels": [image_width, image_height],
        "units": "mm (height normalized, not measured)",
        "dimensionsMm": [round(physical_width, 3), round(physical_depth, 3), physical_height],
        "bboxMm": [[round(-physical_width / 2, 3), round(-physical_depth / 2, 3), 0.0], [round(physical_width / 2, 3), round(physical_depth / 2, 3), physical_height]],
        "grid": {"nx": nx, "ny": ny, "nz": nz},
        "voxelSizeMm": [round(physical_width / nx, 4), round(physical_depth / ny, 4), round(physical_height / nz, 4)],
        "occupiedVoxels": voxel_count,
        "meshVertices": len(vertices),
        "meshQuads": len(faces),
        "boundaryEdges": boundary_edges,
        "nonManifoldEdges": nonmanifold_edges,
        "voxelVolumeMm3": round(voxel_count * physical_width / nx * physical_depth / ny * physical_height / nz, 3),
        "maskViews": {
            name: {
                "bboxPixels": view["bboxPixels"],
                "componentAreaPx": view["componentAreaPx"],
                "filledAreaPx": view["filledAreaPx"],
                "discardedComponents": view["discardedComponents"],
                "heightNormalizedWidthMm": round(
                    canonical[name].shape[1] * physical_height / nz, 3
                ),
            }
            for name in ("front", "side", "back")
            for view in (views[name],)
        },
        "algorithm": "orthographic silhouette visual hull: front/back union in XZ intersected with side silhouette in YZ; exposed voxel faces",
        "algorithmLimits": [
            "Front, side, and back drawings are treated as orthographic, although the source illustrations are not perfectly orthographic or scale-matched.",
            "The front/back silhouette union intentionally preserves appendages visible from either view and can overestimate volume.",
            "The height is normalized to 100 mm; width and depth are ratios from the drawing, not real measurements.",
            "Unseen surface detail is not reconstructed. Face colors are source-image reprojections only and do not recover hidden appearance.",
            "This is a visual hull for shape exploration, not an Agnes/AGH analysis, precision reconstruction, strength check, or printability claim.",
        ],
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }
    payload = {
        "vertices": vertices,
        "faces": faces,
        "faceColors": face_colors,
        "metrics": metrics,
    }
    hull_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    make_mask_diagnostic(image, views, front_back_xz, side_yz, output_dir / "masks.png")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a voxel visual hull from a three-view character sheet.")
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE, help="input three-view PNG/JPEG")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT, help="directory for hull.json and masks.png")
    args = parser.parse_args()
    metrics = build(args.image, args.output_dir)
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
