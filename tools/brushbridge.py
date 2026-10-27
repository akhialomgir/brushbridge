#!/usr/bin/env python3
"""BrushBridge: inspect brush containers, preserve originals, export explicit subsets.
Python 3.9+, standard library only. See README.md for the scope of each guarantee.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

LIMIT = 128 * 1024 * 1024
PIXELS = 32 * 1024 * 1024
EXTENSIONS = {'.gbr', '.gih', '.vbr', '.myb', '.kpp', '.abr'}

class FormatError(ValueError):
    pass

class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0
    def take(self, n):
        if n < 0 or self.pos + n > len(self.data):
            raise FormatError('Truncated or invalid length at byte %d' % self.pos)
        b = self.data[self.pos:self.pos+n]
        self.pos += n
        return b
    def unpack(self, fmt):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))
    def left(self):
        return len(self.data) - self.pos

def sha(b):
    return hashlib.sha256(b).hexdigest()

def dimensions(w, h, channels=1):
    if not (0 < w <= 32767 and 0 < h <= 32767 and w*h*channels <= PIXELS):
        raise FormatError('Invalid or excessive raster dimensions: %s x %s x %s' % (w,h,channels))

def inflate(b):
    d = zlib.decompressobj()
    result = d.decompress(b, LIMIT+1)
    if len(result) > LIMIT or d.unconsumed_tail or not d.eof or d.unused_data:
        raise FormatError('Invalid or excessive compressed metadata')
    return result

def tip(name, w, h, mode, pixels, **extra):
    dimensions(w,h,4 if mode == 'RGBA' else 1)
    if len(pixels) != w*h*(4 if mode == 'RGBA' else 1):
        raise FormatError('Wrong raster length')
    return dict(name=name,width=w,height=h,mode=mode,pixels=pixels,**extra)

def read_gbr(r):
    start = r.pos
    size, version, w, h, channels = r.unpack('>5I')
    if version not in (1,2):
        raise FormatError('Only GBR v1/v2 supported (not float GBR v3)')
    minimum = 28 if version == 2 else 20
    if not minimum < size <= 65536 or channels not in (1,4):
        raise FormatError('Invalid GBR header/depth')
    spacing = None
    if version == 2:
        magic, spacing = r.unpack('>2I')
        if magic != 0x47494D50: raise FormatError('Invalid GBR magic')
    name_bytes = r.take(size-minimum)
    if not name_bytes.endswith(b'\0'): raise FormatError('GBR name not terminated')
    name = name_bytes[:-1].decode('utf-8',errors='replace')
    dimensions(w,h,channels)
    pixels = r.take(w*h*channels)
    return tip(name,w,h,'L' if channels == 1 else 'RGBA',pixels,
               spacing_percent=spacing,gbr_version=version,source_offset=start)

def write_gbr(t):
    name = t['name'].encode('utf-8')+b'\0'
    spacing = t.get('spacing_percent')
    if spacing is None: spacing = 25
    return (struct.pack('>7I',28+len(name),2,t['width'],t['height'],
                        4 if t['mode']=='RGBA' else 1,0x47494D50,int(spacing))
            + name + t['pixels'])

def packbits(row, width):
    r = Reader(row)
    out = bytearray()
    while r.left():
        n = r.take(1)[0]
        if n < 128: out.extend(r.take(n+1))
        elif n > 128: out.extend(r.take(1)*(257-n))
        if len(out) > width: raise FormatError('ABR RLE row overrun')
    if len(out) != width: raise FormatError('ABR RLE row length mismatch')
    return bytes(out)

def read_abr_pixels(r,w,h,depth,compression):
    dimensions(w,h)
    if depth != 8: raise FormatError('Only 8-bit ABR samples supported; no implicit quantization')
    if compression == 0: return r.take(w*h)
    if compression != 1: raise FormatError('Unknown ABR compression')
    lengths = r.unpack('>%dH' % h)
    return b''.join(packbits(r.take(n),w) for n in lengths)

def read_abr(b):
    r = Reader(b)
    version, second = r.unpack('>2H')
    tips, sections, skipped = [], [], []
    metadata = dict(version=version)
    if version in (1,2):
        metadata['record_count'] = second
        for i in range(second):
            kind, size = r.unpack('>HI')
            rec = Reader(r.take(size))
            if kind != 2:
                skipped.append({'record':i,'type':kind,'bytes':size})
                continue
            misc, spacing = rec.unpack('>IH')
            name = 'sample-%03d' % (i+1)
            if version == 2:
                units, = rec.unpack('>I')
                name = rec.take(units*2).decode('utf-16-be').rstrip('\0') or name
            aa = rec.take(1)[0]
            rec.take(8)  # legacy short bounds; long bounds are authoritative
            top,left,bottom,right,depth,compression = rec.unpack('>4iHB')
            w,h = right-left,bottom-top
            pixels = read_abr_pixels(rec,w,h,depth,compression)
            tips.append(tip(name,w,h,'L',pixels,spacing_percent=spacing,
                            antialias=aa,bounds=[top,left,bottom,right],compression=compression))
        if r.left(): raise FormatError('Trailing ABR v1/v2 bytes')
    elif version == 6 and second in (1,2):
        metadata['subversion'] = second
        while r.left():
            sig,tag,size = r.unpack('>4s4sI')
            if sig != b'8BIM': raise FormatError('Invalid ABR section signature')
            start = r.pos
            data = r.take(size)
            sections.append({'tag':tag.decode('ascii',errors='replace'),'offset':start,
                             'bytes':size,'sha256':sha(data)})
            if tag != b'samp': continue
            samples = Reader(data)
            while samples.left():
                length, = samples.unpack('>I')
                rec = Reader(samples.take(length))
                samples.take((-length)%4)
                key = rec.take(37)
                rec.take(10 if second == 1 else 264)
                top,left,bottom,right,depth,compression = rec.unpack('>4iHB')
                w,h = right-left,bottom-top
                pixels = read_abr_pixels(rec,w,h,depth,compression)
                tips.append(tip('sample-%03d' % (len(tips)+1),w,h,'L',pixels,
                                spacing_percent=None,compression=compression,
                                bounds=[top,left,bottom,right],sample_key_hex=key.hex()))
    else:
        raise FormatError('Unsupported ABR version/subversion %d/%d' % (version,second))
    metadata.update(sections=sections,skipped_records=skipped)
    warnings = ['ABR preset descriptors/dynamics are not mapped; sample names in v6 are generated IDs.']
    if skipped: warnings.append('Computed/unknown ABR brush records have no extracted raster.')
    return metadata,tips,warnings

def png_chunks(b):
    if not b.startswith(b'\x89PNG\r\n\x1a\n'): raise FormatError('Not PNG/KPP')
    r = Reader(b[8:])
    while r.left():
        size, tag = r.unpack('>I4s')
        data = r.take(size)
        crc, = r.unpack('>I')
        if zlib.crc32(tag+data)&0xffffffff != crc: raise FormatError('PNG CRC mismatch')
        yield tag,data
        if tag == b'IEND':
            if r.left(): raise FormatError('Trailing PNG data')
            return
    raise FormatError('PNG missing IEND')

def read_kpp(b):
    texts = {}
    for tag,d in png_chunks(b):
        if tag == b'tEXt':
            k,value = d.split(b'\0',1)
            texts[k.decode('latin1')] = value.decode('latin1')
        elif tag == b'zTXt':
            k,value = d.split(b'\0',1)
            if not value or value[0] != 0: raise FormatError('Unsupported PNG text compression')
            texts[k.decode('latin1')] = inflate(value[1:]).decode('utf-8')
        elif tag == b'iTXt':
            k,rest = d.split(b'\0',1)
            flag,method = rest[:2]
            if flag not in (0,1) or method != 0: raise FormatError('Invalid PNG iTXt')
            lang,translated,value = rest[2:].split(b'\0',2)
            texts[k.decode('latin1')] = (inflate(value) if flag else value).decode('utf-8')
    if 'preset' not in texts: raise FormatError('PNG has no Krita preset metadata')
    xml = texts['preset']
    if '<!ENTITY' in xml.upper() or '<!DOCTYPE' in xml.upper().split('<PRESET',1)[0]:
        raise FormatError('Unsafe top-level XML declaration')
    root = ET.fromstring(xml)
    params = {p.attrib['name']:''.join(p.itertext()) for p in root.findall('param')}
    required = params.get('requiredBrushFilesList','').split(';')
    if params.get('requiredBrushFile'): required.append(params['requiredBrushFile'])
    dependencies = sorted(set(x.strip() for x in required if x.strip()))
    return dict(name=root.get('name'),engine=root.get('paintopid'),png_text=texts,
                parameters=params,referenced_resources=dependencies,
                dependency_resolution='not implemented; filenames do not prove embedded resource availability')

def inspect_bytes(b,ext):
    if len(b)>LIMIT: raise FormatError('Input exceeds 128 MiB limit')
    metadata,tips,warnings = {},[],[]
    ext = ext.lower()
    if ext == '.gbr':
        r = Reader(b); tips=[read_gbr(r)]
        if r.left(): raise FormatError('Trailing GBR bytes (legacy PAT extension not supported)')
        metadata={'version':tips[0]['gbr_version']}
    elif ext == '.gih':
        r = Reader(b)
        def line():
            end = b.find(b'\n',r.pos)
            if end<0 or end-r.pos>65536: raise FormatError('Invalid GIH header')
            return r.take(end-r.pos+1)[:-1].decode('utf-8')
        name,line2 = line(),line()
        fields = line2.split()
        count=int(fields[0])
        if not 0<count<=4096: raise FormatError('Invalid GIH cell count')
        params=dict(x.split(':',1) for x in fields[1:])
        metadata=dict(name=name,header_line=line2,cell_count=count,pipe_parameters=params)
        tips=[read_gbr(r) for _ in range(count)]
        if r.left(): raise FormatError('Trailing GIH bytes')
        warnings=['GIH cell selection/dimensional dynamics would be lost by flattening into separate brushes.']
    elif ext == '.vbr':
        lines=b.decode('utf-8').splitlines()
        if len(lines)<2 or lines[0]!='GIMP-VBR': raise FormatError('Invalid VBR magic')
        v=lines[1]
        if v not in ('1.0','1.5') or len(lines)!=(8 if v=='1.0' else 10):
            raise FormatError('Unsupported VBR version/field count')
        if v=='1.0':
            spacing,radius,hardness,aspect,angle=map(float,lines[3:])
            shape,spikes='circle',2
        else:
            shape=lines[3];spacing,radius=float(lines[4]),float(lines[5]);spikes=int(lines[6])
            hardness,aspect,angle=map(float,lines[7:])
        if shape not in ('circle','square','diamond') or not all(map(math.isfinite,[spacing,radius,hardness,aspect,angle])):
            raise FormatError('Invalid VBR shape/number')
        metadata=dict(version=v,name=lines[2],shape=shape,spacing_percent=spacing,
                      radius_px=radius,spikes=spikes,hardness=hardness,aspect_ratio=aspect,angle_deg=angle)
        warnings=['VBR analytic brush preserved as parameters; no approximate rasterization performed.']
    elif ext == '.myb':
        metadata=json.loads(b)
        if not isinstance(metadata,dict) or not isinstance(metadata.get('settings'),dict):
            raise FormatError('Only JSON MyPaint brushes with settings supported (not legacy text MYB)')
        warnings=['MyPaint settings/input curves retained; libmypaint rendering semantics are not translated.']
    elif ext == '.kpp':
        metadata=read_kpp(b)
        warnings=['KPP PNG is a preset preview, NOT a brush tip.',
                  'Krita engine settings are retained; external resource dependencies are listed but unresolved.']
    elif ext == '.abr':
        metadata,tips,warnings=read_abr(b)
    else: raise FormatError('Unsupported extension '+ext)
    return dict(format=ext[1:],metadata=metadata,tips=tips,warnings=warnings)

def inspect_file(path):
    path=Path(path)
    if path.stat().st_size>LIMIT: raise FormatError('Input exceeds 128 MiB limit')
    return inspect_bytes(path.read_bytes(),path.suffix)

def png(t):
    w,h=t['width'],t['height']
    channels=4 if t['mode']=='RGBA' else 1
    def chunk(tag,d):
        return struct.pack('>I',len(d))+tag+d+struct.pack('>I',zlib.crc32(tag+d)&0xffffffff)
    stride=w*channels
    scan=b''.join(b'\0'+t['pixels'][i:i+stride] for i in range(0,len(t['pixels']),stride))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',w,h,8,6 if channels==4 else 0,0,0,0))
            +chunk(b'IDAT',zlib.compress(scan))+chunk(b'IEND',b''))

def preview_tip(t):
    if t['mode']=='RGBA': return t
    # Authoritative L PNG stores coverage (white=opaque); display black ink on alpha.
    pixels=b''.join(bytes((0,0,0,x)) for x in t['pixels'])
    return tip(t['name'],t['width'],t['height'],'RGBA',pixels)

def json_bytes(d):
    return (json.dumps(d,ensure_ascii=False,indent=2,allow_nan=False)+'\n').encode()

def export_bundle(source,out):
    source,out=Path(source),Path(out)
    if out.exists(): raise FormatError('Refusing to overwrite bundle '+str(out))
    doc=inspect_file(source)
    original=source.read_bytes()
    manifest=dict(schema='brushbridge/1',source_name=source.name,source_sha256=sha(original),
                  source_bytes=len(original),format=doc['format'],metadata=doc['metadata'],
                  warnings=doc['warnings'],guarantees=dict(original_bytes=True,raster_samples=True,
                  native_preset_equivalence=False,csp_import_verified=False),tips=[])
    files={'original.bin':original}
    for i,t in enumerate(doc['tips']):
        stem='tips/%03d' % (i+1)
        row={k:v for k,v in t.items() if k!='pixels'}
        row.update(raw_path=stem+'.raw',png_path=stem+'.png',preview_path=stem+'-preview.png',
                   sha256=sha(t['pixels']),mask_convention='coverage: 0=transparent, 255=opaque' if t['mode']=='L' else 'straight RGBA')
        manifest['tips'].append(row)
        files[row['raw_path']]=t['pixels'];files[row['png_path']]=png(t)
        files[row['preview_path']]=png(preview_tip(t))
        files[stem+'.gbr']=write_gbr(t)
    if doc['format']=='kpp':
        files['preset-preview.png']=original
        files['preset.xml']=doc['metadata']['png_text']['preset'].encode('utf-8')
    files['manifest.json']=json_bytes(manifest)
    out.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_DEFLATED) as z:
        for name,data in files.items():z.writestr(name,data)
    return manifest

def read_bundle(path):
    with zipfile.ZipFile(path) as z:
        infos=z.infolist()
        if len(infos)>30000 or sum(i.file_size for i in infos)>LIMIT*4:
            raise FormatError('Bundle too large')
        if len({i.filename for i in infos})!=len(infos): raise FormatError('Duplicate bundle members')
        m=json.loads(z.read('manifest.json'))
        original=z.read('original.bin')
        if sha(original)!=m['source_sha256']: raise FormatError('Original SHA-256 mismatch')
        tips=[]
        for row in m['tips']:
            b=z.read(row['raw_path'])
            if sha(b)!=row['sha256']: raise FormatError('Tip SHA-256 mismatch')
            t=dict(row,pixels=b)
            dimensions(t['width'],t['height'],4 if t['mode']=='RGBA' else 1)
            tip(t['name'],t['width'],t['height'],t['mode'],b)
            tips.append(t)
        return m,original,tips

def write_abr(tips,allow_lossy=False):
    if not tips: raise FormatError('No raster samples; cannot export ABR')
    if len(tips)>32767: raise FormatError('Too many ABR samples')
    records=[];losses=[]
    for t in tips:
        if t['mode']!='L':
            if not allow_lossy: raise FormatError('RGBA color cannot be stored in sampled ABR; use --allow-lossy to export alpha only')
            pixels=t['pixels'][3::4];losses.append('Color discarded; kept alpha silhouette for '+t['name'])
        else: pixels=t['pixels']
        w,h=t['width'],t['height'];dimensions(w,h)
        spacing=t.get('spacing_percent')
        if spacing is None:
            if not allow_lossy: raise FormatError('Unknown spacing; use --allow-lossy to substitute 25%')
            spacing=25;losses.append('Unknown spacing replaced with 25% for '+t['name'])
        if int(spacing)!=spacing or not 1<=spacing<=1000:
            raise FormatError('Spacing outside supported ABR subset (integer 1..1000)')
        name=t['name'].encode('utf-16-be')+b'\0\0'
        body=(struct.pack('>IH',0,int(spacing))+struct.pack('>I',len(name)//2)+name
              +struct.pack('>B4h4iHB',t.get('antialias',1),0,0,h,w,0,0,h,w,8,0)+pixels)
        records.append(struct.pack('>HI',2,len(body))+body)
    return struct.pack('>HH',2,len(tips))+b''.join(records),losses

def export_abr(bundle,out,allow_lossy=False):
    m,original,tips=read_bundle(bundle)
    if m['warnings'] and not allow_lossy:
        raise FormatError('Source has unmapped semantics; export refused. Read manifest or use --allow-lossy.')
    b,losses=write_abr(tips,allow_lossy)
    # This verifies serialized pixels, not another application's behavior.
    parsed=read_abr(b)[1]
    for a,c in zip(tips,parsed):
        expected=a['pixels'] if a['mode']=='L' else a['pixels'][3::4]
        if expected!=c['pixels']: raise FormatError('ABR internal pixel roundtrip failed')
    out=Path(out)
    if out.exists(): raise FormatError('Refusing to overwrite '+str(out))
    out.parent.mkdir(parents=True,exist_ok=True)
    report=dict(source_name=m['source_name'],source_sha256=m['source_sha256'],output_sha256=sha(b),
                abr_version=2,samples=len(tips),losses=m['warnings']+losses,
                raster_roundtrip_verified=True,application_import_verified=False,
                stroke_equivalence_verified=False,
                note='Pixel-preserving subset export does not establish rendering equivalence.')
    out.write_bytes(b)
    out.with_suffix(out.suffix+'.json').write_bytes(json_bytes(report))
    return report

def public_doc(doc):
    return dict(doc, tips=[dict({k:v for k,v in t.items() if k!='pixels'},sha256=sha(t['pixels'])) for t in doc['tips']])

def main():
    p=argparse.ArgumentParser(description=__doc__)
    s=p.add_subparsers(dest='command',required=True)
    a=s.add_parser('inspect');a.add_argument('source')
    a=s.add_parser('pack');a.add_argument('source');a.add_argument('-o','--output',required=True)
    a=s.add_parser('restore');a.add_argument('bundle');a.add_argument('-o','--output',required=True)
    a=s.add_parser('verify');a.add_argument('bundle')
    a=s.add_parser('export-abr');a.add_argument('bundle');a.add_argument('-o','--output',required=True);a.add_argument('--allow-lossy',action='store_true')
    a=s.add_parser('batch');a.add_argument('source_dir');a.add_argument('-o','--output',required=True)
    args=p.parse_args()
    try:
        if args.command=='inspect':result=public_doc(inspect_file(args.source))
        elif args.command=='pack':result=export_bundle(args.source,args.output)
        elif args.command in ('verify','restore'):
            m,b,tips=read_bundle(args.bundle)
            if args.command=='restore':
                dest=Path(args.output);dest.parent.mkdir(parents=True,exist_ok=True)
                with dest.open('xb') as f:f.write(b)
            result=dict(source_sha256=m['source_sha256'],original_bytes_verified=True,tip_hashes_verified=len(tips),native_rendering_verified=False)
        elif args.command=='export-abr':result=export_abr(args.bundle,args.output,args.allow_lossy)
        else:
            root=Path(args.source_dir);out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
            result=[]
            for source in sorted(root.rglob('*')):
                if source.suffix.lower() not in EXTENSIONS or not source.is_file():continue
                rel=source.relative_to(root);dest=out/rel.with_suffix(rel.suffix+'.brushpkg')
                try:
                    m=export_bundle(source,dest)
                    read_bundle(dest)
                    result.append(dict(source=str(rel),bundle=str(dest),format=m['format'],tips=len(m['tips']),
                                       original_bytes_verified=True,warnings=m['warnings'],metadata=m['metadata']))
                except (ValueError,OSError,struct.error,zlib.error,ET.ParseError) as e:
                    result.append(dict(source=str(rel),error=str(e)))
            (out/'inventory.json').write_bytes(json_bytes(result))
            if not result or any('error' in x for x in result):
                print(json_bytes(result).decode());return 1
        print(json_bytes(result).decode())
        return 0
    except (ValueError,OSError,struct.error,zlib.error,ET.ParseError,KeyError,zipfile.BadZipFile) as e:
        print('ERROR: '+str(e),file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
