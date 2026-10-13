"""Regenerate the controlled lamppost and slice three plans in a fresh output directory."""
from pathlib import Path
import datetime,hashlib,json,math,os,shutil,subprocess,sys,uuid
import trimesh
ROOT=Path(__file__).resolve().parents[2]
from reproduce import node_runtime
node=node_runtime(ROOT)
sys.path.insert(0,str(ROOT/'tools/reconstruction'))
from scale_lamppost_case import create_lamppost
out=ROOT/'data/reproduction-runs'/(datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
out.mkdir(parents=True,exist_ok=False)
slicer=ROOT/'data/tools/prusaslicer-2.9.6/PrusaSlicer-2.9.6/prusa-slicer-console.exe'
profile=ROOT/'tools/slicer/fdm-pla-04-auto-support.ini'
rows=[]
for name,diameter,side in [('original-upright',.5,False),('repaired-upright',.8,False),('original-side',.5,True)]:
    mesh=create_lamppost(diameter)
    matrix=trimesh.transformations.rotation_matrix(-math.pi/2,[1,0,0]) if side else trimesh.transformations.translation_matrix([0,0,0])
    mesh.apply_transform(matrix)
    dz=-float(mesh.bounds[0,2]);mesh.apply_translation([0,0,dz]);matrix[2,3]+=dz
    center=(mesh.bounds[0]+mesh.bounds[1])/2
    stl=out/(name+'.stl');gcode=out/(name+'.gcode');mesh.export(stl)
    subprocess.run([str(slicer),'--datadir',str(ROOT/'data/tools/prusaslicer-profile-data'),'--load',str(profile),
                    '--export-gcode','--center','90,90','--output',str(gcode),str(stl)],check=True,cwd=ROOT)
    rows.append({'id':name,'diameterMm':diameter,'side':side,'sourceToPrintMatrix4':matrix.reshape(-1).tolist(),
                 'placementOffsetMm':{'x':90-float(center[0]),'y':90-float(center[1]),'z':0},
                 'stl':stl.name,'stlSha256':hashlib.sha256(stl.read_bytes()).hexdigest(),
                 'gcode':gcode.name,'gcodeSha256':hashlib.sha256(gcode.read_bytes()).hexdigest(),'watertight':bool(mesh.is_watertight)})
(out/'inputs.json').write_text(json.dumps({'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'plans':rows},indent=2)+'\n','utf8')
subprocess.run([node,str(ROOT/'tools/setup/reslice-result.mjs'),str(out)],check=True,cwd=ROOT)
if sys.platform=='win32' and not os.environ.get('XINGZAO_NO_OPEN'):os.startfile(out/'结果.html')
