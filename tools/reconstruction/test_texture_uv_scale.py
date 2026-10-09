import sys
from pathlib import Path
import numpy as np
import pytest
import trimesh
sys.path.insert(0,str(Path(__file__).parent))
from texture_uv_scale import unwrap_normalized_geometry
from texture_probe_core import geometry_signature

def test_parameterizer_receives_unit_scale_and_export_keeps_original_units():
    m=trimesh.creation.box(extents=[.01,.03,.1]);before=geometry_signature(m.vertices,m.faces)
    def parameterize(vertices,faces):
        assert np.ptp(vertices,axis=0).max()==pytest.approx(2)
        assert np.allclose((vertices.max(0)+vertices.min(0))/2,0)
        mapping=np.arange(len(m.vertices));uv=np.random.default_rng(17).random((len(mapping),2))
        return mapping,faces,uv
    out,proof=unwrap_normalized_geometry(m,parameterize)
    assert geometry_signature(out.vertices,out.faces)==before
    assert np.array_equal(out.vertices,m.vertices);assert proof['geometryPreservedAtFloat32'] is True

def test_uv_seam_vertex_split_preserves_each_oriented_triangle():
    m=trimesh.creation.box(extents=[.01,.03,.1]);before=geometry_signature(m.vertices,m.faces)
    def parameterize(vertices,faces):
        mapping=np.asarray(faces).reshape(-1);new_faces=np.arange(len(mapping)).reshape(-1,3)
        uv=np.tile([[0,0],[1,0],[0,1]],(len(faces),1));return mapping,new_faces,uv
    out,_=unwrap_normalized_geometry(m,parameterize)
    assert len(out.vertices)>len(m.vertices);assert geometry_signature(out.vertices,out.faces)==before

def test_bad_uv_or_reversed_mapping_cannot_pass_geometry_check():
    m=trimesh.creation.box()
    def reversed_mapping(v,f):return np.arange(len(v)),f[:,::-1],np.zeros((len(v),2))
    with pytest.raises(ValueError,match='geometry'):
        unwrap_normalized_geometry(m,reversed_mapping)
    def invalid(v,f):return np.arange(len(v)),f,np.full((len(v),2),np.nan)
    with pytest.raises(ValueError,match='UV'):
        unwrap_normalized_geometry(m,invalid)

def test_real_small_scale_uvs_keep_nonzero_area_and_original_geometry():
    m=trimesh.creation.icosphere(subdivisions=2,radius=.0001)
    out,proof=unwrap_normalized_geometry(m)
    assert proof['zeroUVAreaFaces']<len(m.faces)*.05
    assert proof['uniqueUV']>len(m.vertices)*.5
    assert geometry_signature(out.vertices,out.faces)==geometry_signature(m.vertices,m.faces)
    assert np.allclose(out.bounds,m.bounds,atol=0)

def test_nonfinite_and_flat_empty_scale_inputs_are_rejected():
    m=trimesh.creation.box();m.vertices[0,0]=np.nan
    with pytest.raises(ValueError,match='invalid'):
        unwrap_normalized_geometry(m)

def test_wholly_collapsed_uv_map_cannot_be_reported_as_success():
    m=trimesh.creation.box()
    def collapsed(v,f):return np.arange(len(v)),f,np.zeros((len(v),2))
    with pytest.raises(ValueError,match='collapsed'):
        unwrap_normalized_geometry(m,collapsed)
    m=trimesh.Trimesh(vertices=np.zeros((3,3)),faces=[[0,1,2]],process=False)
    with pytest.raises(ValueError,match='scale'):
        unwrap_normalized_geometry(m)
