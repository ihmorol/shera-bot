import json
import math
import struct
from pathlib import Path

OUT = Path(__file__).parent
data = bytearray()
doc = {'asset': {'version': '2.0', 'generator': 'Shera avatar builder'},
       'scene': 0, 'scenes': [{'nodes': [0]}],
       'nodes': [{'name': 'Shera', 'children': []}], 'meshes': [],
       'materials': [], 'accessors': [], 'bufferViews': []}

def material(name, color, roughness=0.8, glow=None):
    m = {'name': name, 'pbrMetallicRoughness': {
        'baseColorFactor': [*color, 1], 'metallicFactor': 0,
        'roughnessFactor': roughness}}
    if glow:
        m['emissiveFactor'] = glow
    doc['materials'].append(m)
    return len(doc['materials']) - 1

orange = material('Apricot plush', [1, .52, .12])
cream = material('Warm cream', [1, .9, .72])
amber = material('Amber trim', [1, .38, .035], .3)
glass = material('Dark glossy face', [.025, .013, .009], .12)
light = material('Warm luminous display', [1, .84, .25], .3, [1, .75, .18])

def accessor(values, kind, integer=False, target=None):
    while len(data) % 4:
        data.append(0)
    flat = [x for v in values for x in v] if kind != 'SCALAR' else values
    blob = struct.pack('<' + ('I' if integer else 'f') * len(flat), *flat)
    view = {'buffer': 0, 'byteOffset': len(data), 'byteLength': len(blob)}
    if target:
        view['target'] = target
    doc['bufferViews'].append(view)
    data.extend(blob)
    a = {'bufferView': len(doc['bufferViews'])-1,
         'componentType': 5125 if integer else 5126,
         'count': len(values), 'type': kind}
    rows = [[x] for x in values] if kind == 'SCALAR' else values
    a['min'] = [min(col) for col in zip(*rows)]
    a['max'] = [max(col) for col in zip(*rows)]
    doc['accessors'].append(a)
    return len(doc['accessors'])-1

def mesh(name, vertices, indices, mat, translation=(0, 0, 0)):
    normals = [[0., 0., 0.] for _ in vertices]
    for k in range(0, len(indices), 3):
        indices[k+1], indices[k+2] = indices[k+2], indices[k+1]
        ids = indices[k:k+3]
        a, b, c = [vertices[i] for i in ids]
        u = [b[i]-a[i] for i in range(3)]
        v = [c[i]-a[i] for i in range(3)]
        n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        for idx in ids:
            for j in range(3):
                normals[idx][j] += n[j]
    normals = [[x/(math.sqrt(sum(t*t for t in n)) or 1) for x in n] for n in normals]
    prim = {'attributes': {'POSITION': accessor(vertices, 'VEC3', target=34962),
                           'NORMAL': accessor(normals, 'VEC3', target=34962)},
            'indices': accessor(indices, 'SCALAR', True, 34963), 'material': mat}
    doc['meshes'].append({'name': name, 'primitives': [prim]})
    node = len(doc['nodes'])
    doc['nodes'].append({'name': name, 'mesh': len(doc['meshes'])-1,
                         'translation': list(translation)})
    doc['nodes'][0]['children'].append(node)
    return node

def solid(name, center, scale, mat, exponent=1):
    vertices, indices = [], []
    rows, cols = 32, 64
    def power(x):
        return math.copysign(abs(x)**exponent, x)
    for i in range(rows+1):
        lat = -math.pi/2 + math.pi*i/rows
        for j in range(cols+1):
            lon = 2*math.pi*j/cols
            vertices.append([scale[0]*power(math.cos(lat))*power(math.cos(lon)),
                             scale[1]*power(math.sin(lat)),
                             scale[2]*power(math.cos(lat))*power(math.sin(lon))])
    for i in range(rows):
        for j in range(cols):
            a = i*(cols+1)+j
            b = a+cols+1
            indices.extend([a, a+1, b, a+1, b+1, b])
    return mesh(name, vertices, indices, mat, center)

def tube(name, center, radius, thickness, mat, start=0, end=2*math.pi):
    vertices, indices = [], []
    for i in range(81):
        a = start+(end-start)*i/80
        for j in range(13):
            b = 2*math.pi*j/12
            r = radius+thickness*math.cos(b)
            vertices.append([r*math.cos(a), r*math.sin(a), thickness*math.sin(b)])
    for i in range(80):
        for j in range(12):
            a = i*13+j
            indices.extend([a, a+1, a+13, a+1, a+14, a+13])
    return mesh(name, vertices, indices, mat, center)

solid('Body', (0, .88, 0), (.57, .59, .4), orange, .65)
solid('Cream chest', (0, .89, .32), (.43, .49, .12), cream, .65)
solid('Neck', (0, 1.47, 0), (.23, .08, .22), glass)
solid('Head', (0, 2.13, 0), (.79, .72, .57), orange, .55)
solid('Face screen', (0, 2.13, .553), (.48, .48, .105), glass)
tube('Cream face bezel', (0, 2.13, .52), .55, .115, cream)
tube('Inner amber bezel', (0, 2.13, .586), .475, .022, amber)
tube('Happy eye', (0, 2.07, .672), .205, .035, light, .13, math.pi-.13)
for side in (-1, 1):
    solid('Ear cushion '+str(side), (side*.805, 2.12, 0), (.12, .285, .27), cream)
    solid('Ear amber cap '+str(side), (side*.9, 2.12, 0), (.065, .205, .19), amber)
solid('Left arm', (-.59, .91, 0), (.22, .32, .22), orange)
solid('Left mitten', (-.71, .69, .07), (.235, .235, .22), cream)
solid('Right raised arm', (.61, 1.08, 0), (.23, .33, .22), orange)
solid('Right waving mitten', (.79, 1.33, .08), (.24, .25, .22), cream)
solid('Chest light housing', (0, 1.02, .449), (.215, .095, .04), amber, .5)
solid('Chest light', (0, 1.02, .486), (.155, .035, .014), light, .5)
solid('Hover rim', (0, .3, 0), (.34, .07, .28), amber)
solid('Hover glow', (0, .22, 0), (.29, .14, .25), light)

times = [i/12 for i in range(49)]
poses = [[0, .055*math.sin(2*math.pi*t/4), 0] for t in times]
doc['animations'] = [{'name': 'Idle float', 'samplers': [
    {'input': accessor(times, 'SCALAR'), 'output': accessor(poses, 'VEC3'), 'interpolation': 'LINEAR'}],
    'channels': [{'sampler': 0, 'target': {'node': 0, 'path': 'translation'}}]}]
doc['buffers'] = [{'byteLength': len(data)}]
encoded = json.dumps(doc, separators=(',', ':')).encode()
encoded += b' ' * (-len(encoded) % 4)
data.extend(b'\0' * (-len(data) % 4))
blob = struct.pack('<III', 0x46546C67, 2, 12+8+len(encoded)+8+len(data))
blob += struct.pack('<II', len(encoded), 0x4E4F534A)+encoded
blob += struct.pack('<II', len(data), 0x004E4942)+data
path = OUT/'shera-main-v1.glb'
path.write_bytes(blob)
assert struct.unpack_from('<III', blob)[2] == len(blob)
assert len(doc['meshes']) >= 18
for view in doc['bufferViews']:
    assert view['byteOffset'] % 4 == 0
    assert view['byteOffset']+view['byteLength'] <= len(data)
for m in doc['meshes']:
    p = m['primitives'][0]
    assert doc['accessors'][p['indices']]['max'][0] < doc['accessors'][p['attributes']['POSITION']]['count']
print(f'Created {path}: {len(blob):,} bytes, {len(doc["meshes"])} meshes; checks passed')

