from pathlib import Path
from types import SimpleNamespace
import sys
import pytest
from PIL import Image

sys.path.insert(0,str(Path(__file__).parent))
from generate_hunyuan_multiview import prepare_view_inputs

def images(tmp_path,side=None):
    paths={}
    for name,color in [('front',(10,20,30,255)),('left',(40,50,60,255)),('back',(70,80,90,255))]:
        file=tmp_path/(name+'.png');Image.new('RGBA',(6,5),color).save(file);paths[name]=file
    args=SimpleNamespace(**paths)
    if side is not None:args.side_view=side
    return args

def test_legacy_input_retains_left_view_tag(tmp_path):
    result,metadata=prepare_view_inputs(images(tmp_path))
    assert list(result)==['front','left','back']
    assert metadata['left']['viewTag']=='left'

def test_right_profile_gets_native_right_tag_without_flipping_pixels(tmp_path):
    args=images(tmp_path,'right');im=Image.open(args.left);im.putpixel((0,0),(255,0,0,255));im.save(args.left)
    result,metadata=prepare_view_inputs(args)
    assert list(result)==['front','right','back']
    assert result['right'].getpixel((0,0))==(255,0,0,255)
    assert result['right'].getpixel((5,0))==(40,50,60,255)
    assert metadata['left']['viewTag']=='right'

def test_unknown_side_is_rejected(tmp_path):
    with pytest.raises(ValueError,match='side view'):
        prepare_view_inputs(images(tmp_path,'up'))
