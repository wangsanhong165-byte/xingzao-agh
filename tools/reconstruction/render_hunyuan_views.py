"""Render front/left/back/perspective previews of one generated raw Y-up GLB.

Usage: blender --background --python render_hunyuan_views.py -- --run-id <safe-id>
Blender's glTF importer performs the single Y-up to Blender Z-up conversion.
"""

import bpy
import bmesh
import json
import os
import re
import sys
import hashlib
from mathutils import Vector


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GENERATED = os.path.join(ROOT, "data", "reconstruction", "generated")
args = sys.argv[sys.argv.index("--") + 1:]
if len(args) not in (2,3) or args[0] != '--run-id' or (len(args)==3 and args[2]!='--render-alpha'):
    raise SystemExit('Expected --run-id <safe-lowercase-id> [--render-alpha]')
render_alpha = len(args)==3
run_id = args[1]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
    raise SystemExit("run-id must contain only lowercase letters, digits, and hyphens")
run_dir = os.path.realpath(os.path.join(GENERATED, run_id))
if os.path.commonpath([os.path.realpath(GENERATED), run_dir]) != os.path.realpath(GENERATED):
    raise SystemExit("run output escaped generated-data directory")
input_path = os.path.join(run_dir, "raw-y-up.glb")
if not os.path.isfile(input_path):
    raise FileNotFoundError("raw-y-up.glb is missing from the selected generated run")
output_dir = os.path.join(run_dir, 'render-alpha' if render_alpha else 'render')
if os.path.exists(output_dir):
    raise FileExistsError("render output already exists; use a new run ID to preserve previous evidence")
os.makedirs(output_dir, exist_ok=False)
with open(input_path,'rb') as stream:input_sha256=hashlib.sha256(stream.read()).hexdigest()

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=input_path)
scene = bpy.context.scene
meshes = [obj for obj in scene.objects if obj.type == "MESH"]
if not meshes:
    raise RuntimeError("GLB import produced no mesh")

world_points = []
bm = bmesh.new()
for obj in meshes:
    world_points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    bm.from_mesh(obj.data)
low = Vector(tuple(min(point[i] for point in world_points) for i in range(3)))
high = Vector(tuple(max(point[i] for point in world_points) for i in range(3)))
center = (low + high) / 2
extents = high - low
extent = max(extents)
checks = {
    "runId": run_id,
    "inputSha256": input_sha256,
    "silhouetteMethod": 'render-alpha' if render_alpha else 'blue-chroma',
    "source": "raw Hunyuan Y-up GLB; Blender glTF importer applies one coordinate conversion",
    "meshObjects": len(meshes),
    "vertices": len(bm.verts),
    "triangles": len(bm.faces),
    "boundaryEdges": sum(1 for edge in bm.edges if edge.is_boundary),
    "nonManifoldEdges": sum(1 for edge in bm.edges if not edge.is_manifold),
    "volumeBlenderUnits3": abs(bm.calc_volume(signed=True)),
    "worldBounds": {"min": list(low), "max": list(high)},
    "worldExtents": list(extents),
    "blenderSceneUpAxis": "Z",
}
bm.free()

for obj in meshes:
    obj.color = (0.11, 0.25, 0.52, 1.0)
    material = bpy.data.materials.new("Single-color shape preview")
    material.diffuse_color = obj.color
    obj.data.materials.append(material)

camera_data = bpy.data.cameras.new("Review camera")
camera = bpy.data.objects.new("Review camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
camera_data.type = "ORTHO"
camera_data.ortho_scale = extent * 1.3
camera_data.clip_start = max(extent * 0.001, 0.001)
camera_data.clip_end = max(extent * 10, 1000)
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.display.shading.cavity_type = "BOTH"
scene.display.shading.background_type = "WORLD"
scene.world = bpy.data.worlds.new("Neutral background")
scene.world.color = (0.96, 0.96, 0.96)
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = 'RGBA' if render_alpha else 'RGB'
scene.render.film_transparent = render_alpha

distance = max(extent * 4, 10)
views = [
    ("front", Vector((0, -1, 0))),
    ("left", Vector((1, 0, 0))),
    ("right", Vector((-1, 0, 0))),
    ("back", Vector((0, 1, 0))),
    ("perspective", Vector((1.4, -1.8, 1.4))),
]
checks["renderViewCameraDirectionsZUp"] = {name: list(direction) for name, direction in views}
for name, direction in views:
    direction.normalize()
    camera.location = center + direction * distance
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.abspath(os.path.join(output_dir, name + ".png"))
    bpy.ops.render.render(write_still=True)

with open(input_path,'rb') as stream:
    if hashlib.sha256(stream.read()).hexdigest()!=input_sha256:raise ValueError('RENDER_SOURCE_CHANGED')

with open(os.path.join(output_dir, "blender-checks.json"), "w", encoding="utf-8") as stream:
    json.dump(checks, stream, ensure_ascii=False, indent=2)
scene.render.filepath = output_dir + os.sep
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output_dir, "oriented-model.blend"))
print(json.dumps(checks, ensure_ascii=False))
