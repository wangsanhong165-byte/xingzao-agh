"""Build a normalized editable character scene from a data-only JSON recipe.

Run with Blender 4.5:
    blender --background --python tools/build_character.py -- <recipe.json> <outdir>

Recipe values describe an approximate reconstruction. No recipe code is loaded
or evaluated by this script.
"""

import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector


MAX_RECIPE_BYTES = 1_000_000
MAX_PARTS = 100
MAX_COORDINATE = 200.0
MAX_SIZE = 200.0
MAX_POINTS = 20
SUPPORTED_SHAPES = {"ellipsoid", "box", "cone", "torus", "curve"}
TOP_KEYS = {"name", "heightMm", "parts", "assumptions", "limitations"}
PART_KEYS = {"name", "shape", "position", "size", "rotation", "color", "points", "radius"}


def _finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be a finite number")
    return result


def _vector(value, length, label, *, minimum=None, maximum=None):
    if not isinstance(value, list) or len(value) != length:
        raise ValueError(f"{label} must be an array of {length} numbers")
    result = [_finite_number(item, f"{label}[{i}]") for i, item in enumerate(value)]
    if minimum is not None and any(item < minimum for item in result):
        raise ValueError(f"{label} values must be at least {minimum}")
    if maximum is not None and any(item > maximum for item in result):
        raise ValueError(f"{label} values must be no more than {maximum}")
    return result


def _text(value, label, maximum=200):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must be a non-empty string of at most {maximum} characters")
    return value.strip()


def _string_list(value, label):
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError(f"{label} must be an array with at most 100 strings")
    return [_text(item, f"{label}[{i}]", 1000) for i, item in enumerate(value)]


def _load_recipe(path):
    recipe_path = Path(path)
    size = recipe_path.stat().st_size
    if size <= 0 or size > MAX_RECIPE_BYTES:
        raise ValueError("recipe.json must be between 1 byte and 1 MB")
    raw = recipe_path.read_text(encoding="utf-8")
    recipe = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid JSON constant: {value}")))
    if not isinstance(recipe, dict):
        raise ValueError("Recipe root must be an object")
    unknown = set(recipe) - TOP_KEYS
    missing = TOP_KEYS - set(recipe)
    if unknown or missing:
        raise ValueError(f"Recipe keys mismatch; missing={sorted(missing)}, unknown={sorted(unknown)}")
    name = _text(recipe["name"], "name", 120)
    height_mm = _finite_number(recipe["heightMm"], "heightMm")
    if abs(height_mm - 100.0) > 1e-6:
        raise ValueError("heightMm must be 100 for normalized-scale output")
    if not isinstance(recipe["parts"], list) or not (1 <= len(recipe["parts"]) <= MAX_PARTS):
        raise ValueError("parts must contain between 1 and 100 objects")
    assumptions = _string_list(recipe["assumptions"], "assumptions")
    limitations = _string_list(recipe["limitations"], "limitations")

    parts = []
    seen_names = set()
    for index, item in enumerate(recipe["parts"]):
        label = f"parts[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{label} must be an object")
        unknown = set(item) - PART_KEYS
        expected = PART_KEYS.intersection(item)
        required = {"name", "shape", "color"}
        if item.get("shape") != "curve":
            required |= {"position", "size"}
        missing = required - expected
        if unknown or missing:
            raise ValueError(f"{label} keys mismatch; missing={sorted(missing)}, unknown={sorted(unknown)}")
        part_name = _text(item["name"], f"{label}.name", 80)
        if part_name in seen_names:
            raise ValueError(f"Part names must be unique: {part_name}")
        seen_names.add(part_name)
        shape = item["shape"]
        if shape not in SUPPORTED_SHAPES:
            raise ValueError(f"{label}.shape must be one of {sorted(SUPPORTED_SHAPES)}")
        position = _vector(item.get("position", [0, 0, 0]), 3, f"{label}.position", minimum=-MAX_COORDINATE, maximum=MAX_COORDINATE)
        size = _vector(item.get("size", [1, 1, 1]), 3, f"{label}.size", minimum=0, maximum=MAX_SIZE)
        color = _vector(item["color"], 3, f"{label}.color", minimum=0, maximum=1)
        rotation = _vector(item.get("rotation", [0, 0, 0]), 3, f"{label}.rotation")
        if any(abs(angle) > 36000 for angle in rotation):
            raise ValueError(f"{label}.rotation angles must be within +/-36000 degrees")
        if shape in {"ellipsoid", "box"} and any(dimension <= 0 for dimension in size):
            raise ValueError(f"{label}.size values must be positive")
        if shape == "cone" and (size[0] <= 0 or size[1] < 0 or size[2] <= 0):
            raise ValueError(f"{label}.size cone diameters/heights are invalid")
        if shape == "torus" and (size[0] <= 0 or size[1] <= 0 or size[2] < 0 or size[1] >= size[0]):
            raise ValueError(f"{label}.size torus radii are invalid")
        if shape == "curve" and any(dimension <= 0 for dimension in size):
            raise ValueError(f"{label}.size values must be positive")
        if shape != "curve" and ("points" in item or "radius" in item):
            raise ValueError(f"{label} points/radius are only valid for shape=curve")
        points = None
        radius = None
        if shape == "curve":
            if "points" not in item or "radius" not in item:
                raise ValueError(f"{label} curve requires points and radius")
            if not isinstance(item["points"], list) or not (2 <= len(item["points"]) <= MAX_POINTS):
                raise ValueError(f"{label}.points must contain between 2 and 20 points")
            points = [
                _vector(point, 3, f"{label}.points[{point_index}]", minimum=-MAX_COORDINATE, maximum=MAX_COORDINATE)
                for point_index, point in enumerate(item["points"])
            ]
            radius = _finite_number(item["radius"], f"{label}.radius")
            if not 0 < radius <= MAX_SIZE:
                raise ValueError(f"{label}.radius must be positive and no more than 200")
        parts.append({
            "name": part_name,
            "shape": shape,
            "position": position,
            "size": size,
            "rotation": rotation,
            "color": color,
            "points": points,
            "radius": radius,
        })
    return {"name": name, "heightMm": height_mm, "parts": parts, "assumptions": assumptions, "limitations": limitations}


def _material(name, rgb):
    material = bpy.data.materials.new(name=f"{name} 材质")
    material.diffuse_color = (*rgb, 1.0)
    material.use_nodes = True
    shader = next((node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
    if shader is not None:
        shader.inputs["Base Color"].default_value = (*rgb, 1.0)
        shader.inputs["Alpha"].default_value = 1.0
    return material


def _make_curve_mesh(part):
    pivot = Vector(part["position"])
    rotation = Euler(tuple(math.radians(value) for value in part["rotation"]), "XYZ").to_matrix()
    world_points = [pivot + rotation @ (Vector(point) - pivot) for point in part["points"]]
    curve_data = bpy.data.curves.new(f"{part['name']} path", type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 12
    curve_data.bevel_depth = part["radius"]
    curve_data.bevel_resolution = 3
    curve_data.use_fill_caps = True
    spline = curve_data.splines.new("BEZIER")
    spline.bezier_points.add(len(world_points) - 1)
    for point, coordinate in zip(spline.bezier_points, world_points):
        point.co = coordinate
        point.handle_left_type = 'AUTO'
        point.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(part["name"], curve_data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.view_layer.objects.active
    obj.name = part["name"]
    return obj


def _build_part(part):
    name = part["name"]
    position = Vector(part["position"])
    rotation = tuple(math.radians(value) for value in part["rotation"])
    shape = part["shape"]
    size = part["size"]

    if shape == "ellipsoid":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, radius=1.0, location=position)
        obj = bpy.context.object
        obj.scale = Vector(size) * 0.5
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    elif shape == "box":
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=position)
        obj = bpy.context.object
        obj.dimensions = Vector(size)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    elif shape == "cone":
        bpy.ops.mesh.primitive_cone_add(
            vertices=32,
            radius1=size[0] * 0.5,
            radius2=size[1] * 0.5,
            depth=size[2],
            location=position,
        )
        obj = bpy.context.object
    elif shape == "torus":
        bpy.ops.mesh.primitive_torus_add(
            major_segments=48,
            minor_segments=12,
            major_radius=size[0],
            minor_radius=size[1],
            location=position,
        )
        obj = bpy.context.object
    else:
        obj = _make_curve_mesh(part)

    obj.name = name
    obj.data.name = f"{name} mesh"
    if shape != "curve":
        obj.rotation_euler = rotation
    else:
        obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.color = (*part["color"], 1.0)
    obj.data.materials.append(_material(name, part["color"]))
    obj["part_name"] = name
    obj["primitive"] = shape
    obj["editable_component"] = True
    if shape in {"ellipsoid", "cone", "torus", "curve"}:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    obj.select_set(False)
    return obj


def _bounds(objects):
    bpy.context.view_layer.update()
    points = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        points.extend(evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box)
    if not points:
        raise ValueError("No geometry was built")
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def _normalize_height(objects, target_mm):
    minimum, maximum = _bounds(objects)
    span = maximum.z - minimum.z
    if not math.isfinite(span) or span <= 1e-6:
        raise ValueError("Recipe does not define a non-zero vertical extent")
    scale = target_mm / span
    origin = Vector(((minimum.x + maximum.x) * 0.5, (minimum.y + maximum.y) * 0.5, minimum.z))
    for obj in objects:
        obj.location = (obj.location - origin) * scale
        obj.scale *= scale
    bpy.context.view_layer.update()
    return _bounds(objects)


def _set_white_workbench():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.display.shading.background_type = "WORLD"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("White studio")
    scene.world.color = (1.0, 1.0, 1.0)
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.camera.data.type = "ORTHO"


def _render_views(objects, minimum, maximum, output_dir):
    scene = bpy.context.scene
    center = (minimum + maximum) * 0.5
    extent = maximum - minimum
    largest = max(extent.x, extent.y, extent.z, 1.0)
    camera_data = bpy.data.cameras.new("View camera")
    camera = bpy.data.objects.new("View camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    _set_white_workbench()
    views = [
        ("front.png", Vector((0, -1, 0))),
        ("side.png", Vector((1, 0, 0))),
        ("back.png", Vector((0, 1, 0))),
        ("perspective.png", Vector((1.4, -1.8, 1.35))),
    ]
    for filename, direction in views:
        direction.normalize()
        camera.location = center + direction * largest * 4.0
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        if filename == "perspective.png":
            camera_data.type = "PERSP"
            camera_data.lens = 50
        else:
            camera_data.type = "ORTHO"
            camera_data.ortho_scale = largest * 1.35
        scene.render.filepath = os.path.join(output_dir, filename)
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)
    scene.camera = None


def _export_glb(objects, output_path):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(output_path), export_format="GLB", use_selection=True, export_apply=True)
    bpy.ops.object.select_all(action="DESELECT")


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 2:
        raise ValueError("Usage: blender --background --python tools/build_character.py -- <recipe.json> <outdir>")
    recipe_path, output_dir = [str(Path(value).resolve()) for value in args]
    recipe = _load_recipe(recipe_path)
    os.makedirs(output_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001  # one Blender unit is one millimeter
    bpy.context.preferences.filepaths.save_version = 0
    scene["reconstruction_mode"] = "approximate-normalized-100mm"
    scene["source_recipe"] = os.path.basename(recipe_path)
    scene["not_measured"] = True

    objects = [_build_part(part) for part in recipe["parts"]]
    minimum, maximum = _normalize_height(objects, recipe["heightMm"])
    dimensions = list(maximum - minimum)

    _render_views(objects, minimum, maximum, output_dir)
    _export_glb(objects, Path(output_dir) / "model.glb")
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(output_dir) / "model.blend"))

    summary = {
        "name": recipe["name"],
        "normalized": True,
        "heightMm": recipe["heightMm"],
        "boundingDimensionsMm": [round(value, 3) for value in dimensions],
        "partsCount": len(objects),
        "partNames": [obj.name for obj in objects],
        "assumptions": recipe["assumptions"],
        "limitations": recipe["limitations"],
        "notice": "Approximate reconstruction at normalized 100 mm height. Not dimensionally measured, load-rated, or certified for 3D printing.",
    }
    with open(Path(output_dir) / "summary.json", "w", encoding="utf-8") as stream:
        json.dump(summary, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"ok": True, "summary": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
