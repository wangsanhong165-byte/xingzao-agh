"""Render two actual Z-up/mm STL files with identical camera/material settings."""
import sys,json,hashlib
from pathlib import Path
import bpy
from mathutils import Vector

args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=3:raise SystemExit('expected original.stl repaired.stl new-output-directory')
root=Path(__file__).resolve().parents[2];data=(root/'data').resolve()
sources=[Path(a).resolve() for a in args[:2]];out=Path(args[2]).resolve()
if any(not p.is_file() or p.suffix.lower()!='.stl' or not p.is_relative_to(data) for p in sources) or not out.is_relative_to(data):raise ValueError('OBJECT_REVIEW_PATH_INVALID')
out.mkdir(exist_ok=False)
hashes=[hashlib.sha256(p.read_bytes()).hexdigest() for p in sources]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene;groups=[];bounds=[]
material=bpy.data.materials.new('Shared neutral inspection material');material.diffuse_color=(.74,.83,.79,1);material.use_nodes=True
principled=next(n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
principled.inputs['Base Color'].default_value=(.74,.83,.79,1)
principled.inputs['Roughness'].default_value=.68
for i,p in enumerate(sources):
    before=set(scene.objects);bpy.ops.wm.stl_import(filepath=str(p),global_scale=1)
    loaded=[o for o in scene.objects if o not in before and o.type=='MESH']
    if not loaded:raise ValueError('OBJECT_REVIEW_NO_MESH')
    points=[o.matrix_world@Vector(c) for o in loaded for c in o.bound_box]
    lo=Vector([min(q[k] for q in points) for k in range(3)]);hi=Vector([max(q[k] for q in points) for k in range(3)])
    bounds.append([list(lo),list(hi)]);groups.append(loaded)
    for o in loaded:o.data.materials.clear();o.data.materials.append(material)
if max(abs(bounds[0][e][k]-bounds[1][e][k]) for e in range(2) for k in range(3))>1e-5:raise ValueError('OBJECT_REVIEW_BOUNDS_CHANGED')
lo,hi=map(Vector,bounds[0]);center=(lo+hi)/2;extent=max(hi-lo)
cam_data=bpy.data.cameras.new('Shared orthographic camera');camera=bpy.data.objects.new('Inspection camera',cam_data);scene.collection.objects.link(camera);scene.camera=camera
cam_data.type='ORTHO';cam_data.ortho_scale=extent*1.12;cam_data.clip_start=.001;cam_data.clip_end=extent*100
camera.location=center+Vector((.8,-1.5,.4)).normalized()*extent*4;camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
scene.world=bpy.data.worlds.new('Neutral world');scene.world.use_nodes=True
background=next(n for n in scene.world.node_tree.nodes if n.type=='BACKGROUND')
background.inputs['Color'].default_value=(.92,.95,.94,1)
background.inputs['Strength'].default_value=.7
light_data=bpy.data.lights.new('Inspection sun','SUN');light_data.energy=2.4;light_data.angle=.25
light=bpy.data.objects.new('Inspection sun',light_data);scene.collection.objects.link(light);light.rotation_euler=(.3,-.5,-.6)
scene.render.engine='BLENDER_EEVEE_NEXT';scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
scene.render.resolution_x=640;scene.render.resolution_y=760;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG'
for selected,name in enumerate(['original','repaired']):
    for i,group in enumerate(groups):
        for obj in group:obj.hide_render=i!=selected
    scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==digest for p,digest in zip(sources,hashes))
(out/'render-metadata.json').write_text(json.dumps({'sourceSha256':hashes,'boundsMm':bounds,'coordinateFrame':'STL source Z-up/mm, no geometry transformation','scope':'actual meshes, shared orthographic camera/material, no geometry or texture retouch'},indent=2)+'\n',encoding='utf8')
print('COMPLETE_OBJECT_REVIEW_RENDERED')
