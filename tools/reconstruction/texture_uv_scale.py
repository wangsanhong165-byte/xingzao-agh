"""Compute UVs at stable scale, retaining original oriented surface coordinates."""
import numpy as np
import trimesh
from texture_probe_core import geometry_signature

def uv_quality_stats(faces,uv):
    faces=np.asarray(faces,dtype=np.int64);uv=np.asarray(uv)
    if uv.ndim!=2 or uv.shape[1]!=2 or not np.isfinite(uv).all() or uv.min()<0 or uv.max()>1:raise ValueError('UV coordinates are invalid')
    tri=uv[faces];a,b=tri[:,1]-tri[:,0],tri[:,2]-tri[:,0];area=.5*np.abs(a[:,0]*b[:,1]-a[:,1]*b[:,0])
    zero=int(np.count_nonzero(area<=1e-14))
    if float(area.sum())<=1e-8 or zero>len(faces)*.1:raise ValueError('UV parameterization collapsed too many triangles')
    return {'faces':len(faces),'uvVertices':len(uv),'uniqueUV':len(np.unique(uv,axis=0)),'zeroUVAreaFaces':zero,'uvAreaTotal':round(float(area.sum()),9)}

def unwrap_normalized_geometry(mesh,parameterize=None):
    vertices=np.asarray(mesh.vertices,dtype=np.float64);faces=np.asarray(mesh.faces,dtype=np.int64)
    if len(vertices)==0 or len(faces)==0 or not np.isfinite(vertices).all():raise ValueError('UV input geometry is invalid')
    extent=float(np.ptp(vertices,axis=0).max())
    if not np.isfinite(extent) or extent<=0:raise ValueError('UV input scale is invalid')
    working=(vertices-(vertices.min(0)+np.ptp(vertices,axis=0)/2))*(2/extent)
    if parameterize is None:
        import xatlas
        parameterize=xatlas.parametrize
    mapping,indices,uv=parameterize(np.asarray(working,np.float32),np.asarray(faces,np.uint32))
    mapping=np.asarray(mapping);indices=np.asarray(indices);uv=np.asarray(uv)
    if mapping.ndim!=1 or mapping.dtype.kind not in 'iu' or len(mapping)==0 or mapping.min()<0 or mapping.max()>=len(vertices):raise ValueError('UV vertex mapping is invalid')
    if indices.shape!=faces.shape or indices.dtype.kind not in 'iu' or indices.min()<0 or indices.max()>=len(mapping):raise ValueError('UV triangle mapping is invalid')
    if uv.shape!=(len(mapping),2) or not np.isfinite(uv).all() or uv.min()<0 or uv.max()>1:raise ValueError('UV coordinates are invalid')
    out=trimesh.Trimesh(vertices=vertices[mapping],faces=indices,process=False)
    before=geometry_signature(vertices,faces)
    if geometry_signature(out.vertices,out.faces)!=before:raise ValueError('UV mapping changed oriented geometry')
    out.visual=trimesh.visual.texture.TextureVisuals(uv=uv)
    stats=uv_quality_stats(indices,uv)
    proof={'recipe':'normalized-uv-working-copy-v1','inputLongestEdge':extent,'workingLongestEdge':2,**stats,'geometryPreservedAtFloat32':True,'inputGeometrySignature':before}
    return out,proof
