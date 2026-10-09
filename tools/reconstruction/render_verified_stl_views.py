"""Read-only alpha views of a hash-bound normalized STL; no geometry edits."""
import sys,json,hashlib,argparse
from pathlib import Path
import bpy
from mathutils import Vector

args=sys.argv[sys.argv.index('--')+1:]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',required=True,type=Path)
parser.add_argument('--sha',required=True)
parser.add_argument('--output-dir',required=True,type=Path)
options=parser.parse_args(args)
root=Path(__file__).resolve().parents[2]
source=options.source.resolve();out=options.output_dir.resolve()
allowed=[(root/'data').resolve(),(root/'case').resolve()]
if not any(source.is_relative_to(p) for p in allowed) or not any(out.is_relative_to(p) for p in allowed):raise ValueError('STL_REVIEW_PATH_INVALID')
if not source.is_file() or source.suffix.lower()!='.stl' or source.stat().st_size>25*1024*1024:raise ValueError('STL_REVIEW_INPUT_INVALID')
digest=hashlib.sha256(source.read_bytes()).hexdigest()
if digest!=options.sha:raise ValueError('STL_REVIEW_SHA_MISMATCH')
out.mkdir(parents=True,exist_ok=False)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=str(source),global_scale=1)
meshes=[obj for obj in bpy.context.scene.objects if obj.type=='MESH']
points=[obj.matrix_world@Vector(p) for obj in meshes for p in obj.bound_box]
if not points:raise ValueError('STL_REVIEW_EMPTY')
low=Vector([min(p[i] for p in points) for i in range(3)]);high=Vector([max(p[i] for p in points) for i in range(3)])
center=(low+high)/2;extent=max(high-low)
material=bpy.data.materials.new('Neutral geometry review');material.diffuse_color=(.11,.25,.52,1)
for obj in meshes:obj.data.materials.clear();obj.data.materials.append(material)
scene=bpy.context.scene;scene.render.engine='BLENDER_WORKBENCH';scene.display.shading.light='STUDIO';scene.display.shading.color_type='MATERIAL';scene.display.shading.show_cavity=True;scene.display.shading.cavity_type='BOTH';scene.display.shading.show_shadows=True
scene.view_settings.view_transform='Standard';scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.film_transparent=True
camera_data=bpy.data.cameras.new('Fixed source camera');camera_data.type='ORTHO';camera_data.ortho_scale=extent*1.3;camera_data.clip_start=max(extent*.001,.001);camera_data.clip_end=max(extent*10,1000)
camera=bpy.data.objects.new('Fixed source camera',camera_data);scene.collection.objects.link(camera);scene.camera=camera
directions={'front':(0,-1,0),'left':(1,0,0),'back':(0,1,0),'perspective':(1.4,-1.8,1.4)}
for name,direction in directions.items():
    camera.location=center+Vector(direction).normalized()*max(extent*4,10);camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler();scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
if hashlib.sha256(source.read_bytes()).hexdigest()!=digest:raise ValueError('STL_REVIEW_SOURCE_CHANGED')
report={'schema':'verified-stl-alpha-review/v1','sourceSha256':digest,'sourceName':source.name,'frame':'normalized source Z-up/mm','boundsMm':[list(low),list(high)],'triangles':sum(len(obj.data.polygons) for obj in meshes),'cameraDirections':directions,'projection':'ORTHO','orthoScale':extent*1.3,'resolution':[640,640],'silhouetteMethod':'render-alpha','physicalPrintVerified':False,'scope':'supplied STL geometry with fixed cameras, no reshaping or image retouch'}
(out/'blender-checks.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
