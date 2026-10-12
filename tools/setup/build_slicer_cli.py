"""Make a CLI review kit from the unmodified official PrusaSlicer release."""
from pathlib import Path
import hashlib,json,sys,zipfile
OFFICIAL_SHA='5aaf22e42f95accecfa122d23a835911f289ecc2ff606db3e83d637ddcc0a209'
source,out,manifest=map(Path,sys.argv[1:])
assert hashlib.sha256(source.read_bytes()).hexdigest()==OFFICIAL_SHA,'Official release hash mismatch'
def excluded(n):
    return (n.endswith('/OCCTWrapper.dll') or '/mesa/' in n or '/resources/shapes/' in n or '/resources/data/printer_gantries/' in n
            or n.endswith('NotoSansCJK-Regular.ttc')
            or ('/resources/profiles/' in n and n.endswith(('.stl','.png','.svg'))))
out.parent.mkdir(parents=True,exist_ok=True)
files=[]
with zipfile.ZipFile(source) as src,zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as dst:
    assert src.testzip() is None
    for item in src.infolist():
        if item.is_dir() or excluded(item.filename):continue
        b=src.read(item.filename);dst.writestr(item.filename,b)
        files.append({'path':item.filename,'sha256':hashlib.sha256(b).hexdigest()})
    dst.writestr('PrusaSlicer-2.9.6/ORIGIN.txt',
        'PrusaSlicer 2.9.6 CLI kit for the Xingzao fixed FDM profiles. Executables and DLLs are unchanged.\n'
        'Only GUI demo shapes, bed previews, the bundled CJK font, Mesa fallback and unused STEP-import wrapper were omitted.\n'
        'Full release and matching source (AGPL-3.0): https://github.com/prusa3d/PrusaSlicer/releases/tag/version_2.9.6\n'
        'Official archive SHA256: '+OFFICIAL_SHA+'\n')
record={'version':'2.9.6','sha256':hashlib.sha256(out.read_bytes()).hexdigest(),
        'officialArchiveSha256':OFFICIAL_SHA,'sourceUrl':'https://github.com/prusa3d/PrusaSlicer/tree/version_2.9.6',
        'files':files,'scope':'STL FDM CLI runtime; GUI demo and STEP-import assets omitted'}
manifest.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n','utf8')
print(json.dumps({'bytes':out.stat().st_size,'sha256':record['sha256'],'unchangedFiles':len(files)}))
