import json
import math
import random
import struct
import copy
import io
from bisect import bisect_left
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).parent
data = bytearray()
surfaces = []
rng = random.Random(23)
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

orange = material('Honey orange plush', [.94, .36, .065], .98)
cream = material('Ivory plush', [.96, .84, .67], .98)
amber = material('Amber trim', [1, .29, .022], .28)
glass = material('Dark glossy face', [.025, .013, .009], .12)
light = material('Warm luminous display', [1, .85, .36], .25, [1, .8, .34])
doc['materials'][glass]['extensions'] = {'KHR_materials_clearcoat': {
    'clearcoatFactor': 1, 'clearcoatRoughnessFactor': .16}}
for mat in (orange, cream):
    doc['materials'][mat]['extensions'] = {'KHR_materials_sheen': {
        'sheenColorFactor': [.35, .25, .16], 'sheenRoughnessFactor': .9}}
doc['extensionsUsed'] = ['KHR_materials_sheen', 'KHR_materials_clearcoat']
fiber_materials = {}
for mat in (orange, cream):
    fiber = copy.deepcopy(doc['materials'][mat])
    fiber['name'] += ' fibers'
    fiber_materials[mat] = len(doc['materials'])
    doc['materials'].append(fiber)

height_image = Image.new('L', (1024, 1024), 128)
draw = ImageDraw.Draw(height_image)
for _ in range(42000):
    x, y = rng.randrange(1024), rng.randrange(1024)
    a, length = rng.uniform(-.7, .7), rng.uniform(4, 14)
    draw.line([(x, y), (x+math.sin(a)*length*.4, y+length*.5),
               (x+math.sin(a)*length, y+length)], fill=rng.randrange(80, 190), width=1)
height_field = np.asarray(height_image.filter(ImageFilter.GaussianBlur(.5)), dtype=float)/255
dy, dx = np.gradient(height_field)
normal_field = np.stack((-dx*2, -dy*2, np.ones_like(dx)), axis=-1)
normal_field /= np.linalg.norm(normal_field, axis=-1, keepdims=True)
normal_image = Image.fromarray(np.uint8((normal_field*.5+.5)*255))
png = io.BytesIO()
normal_image.save(png, format='PNG')
png_bytes = png.getvalue()
doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(data), 'byteLength': len(png_bytes)})
data.extend(png_bytes)
doc['images'] = [{'name': 'Fine brushed plush normal', 'bufferView': 0, 'mimeType': 'image/png'}]
doc['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
doc['textures'] = [{'source': 0, 'sampler': 0}]
for mat in (orange, cream):
    doc['materials'][mat]['normalTexture'] = {'index': 0, 'scale': .8}

def normalize(v):
    length = math.sqrt(sum(x*x for x in v)) or 1
    return [x/length for x in v]

def cross(u, v):
    return [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]

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

def mesh(name, vertices, indices, mat, translation=(0, 0, 0), normals=None, parent=0, uvs=None):
    if parent == 1 and normals is None:
        translation = (translation[0], translation[1]-1.96, translation[2])
    if normals is None:
        normals = [[0., 0., 0.] for _ in vertices]
        for k in range(0, len(indices), 3):
            indices[k+1], indices[k+2] = indices[k+2], indices[k+1]
            ids = indices[k:k+3]
            a, b, c = [vertices[i] for i in ids]
            n = cross([b[i]-a[i] for i in range(3)], [c[i]-a[i] for i in range(3)])
            for idx in ids:
                for j in range(3):
                    normals[idx][j] += n[j]
        welded = {}
        for vertex, n in zip(vertices, normals):
            key = tuple(round(x, 6) for x in vertex)
            total = welded.setdefault(key, [0., 0., 0.])
            for j in range(3):
                total[j] += n[j]
        normals = [normalize(welded[tuple(round(x, 6) for x in vertex)]) for vertex in vertices]
        surfaces.append((name, vertices, indices, normals, mat, translation, parent))
    prim = {'attributes': {'POSITION': accessor(vertices, 'VEC3', target=34962),
                           'NORMAL': accessor(normals, 'VEC3', target=34962)},
            'indices': accessor(indices, 'SCALAR', True, 34963), 'material': mat}
    if uvs is not None:
        prim['attributes']['TEXCOORD_0'] = accessor(uvs, 'VEC2', target=34962)
    doc['meshes'].append({'name': name, 'primitives': [prim]})
    node = len(doc['nodes'])
    doc['nodes'].append({'name': name, 'mesh': len(doc['meshes'])-1,
                         'translation': list(translation)})
    doc['nodes'][parent].setdefault('children', []).append(node)
    return node

def solid(name, center, scale, mat, exponent=1, parent=0, pear=0, angle=0):
    vertices, indices, uvs = [], [], []
    rows, cols = 32, 64
    def power(x):
        return math.copysign(abs(x)**exponent, x)
    for i in range(rows+1):
        lat = -math.pi/2 + math.pi*i/rows
        for j in range(cols+1):
            lon = 2*math.pi*j/cols
            taper = 1-pear*math.sin(lat)
            x = scale[0]*power(math.cos(lat))*power(math.cos(lon))*taper
            y = scale[1]*power(math.sin(lat))
            z = scale[2]*power(math.cos(lat))*power(math.sin(lon))*taper
            vertices.append([x*math.cos(angle)-y*math.sin(angle),
                             x*math.sin(angle)+y*math.cos(angle), z])
            uvs.append([j/cols*2, i/rows])
    for i in range(rows):
        for j in range(cols):
            a = i*(cols+1)+j
            b = a+cols+1
            indices.extend([a, a+1, b, a+1, b+1, b])
    return mesh(name, vertices, indices, mat, center, parent=parent, uvs=uvs)

def tube(name, center, radius, thickness, mat, start=0, end=2*math.pi, parent=0):
    vertices, indices, uvs = [], [], []
    for i in range(81):
        a = start+(end-start)*i/80
        for j in range(13):
            b = 2*math.pi*j/12
            r = radius+thickness*math.cos(b)
            vertices.append([r*math.cos(a), r*math.sin(a), thickness*math.sin(b)])
            uvs.append([i/80*3, j/12])
    for i in range(80):
        for j in range(12):
            a = i*13+j
            indices.extend([a, a+1, a+13, a+1, a+14, a+13])
    node = mesh(name, vertices, indices, mat, center, parent=parent, uvs=uvs)
    if end-start < 2*math.pi-.01:
        for a in (start, end):
            solid(name+' rounded end', (center[0]+radius*math.cos(a),
                  center[1]+radius*math.sin(a), center[2]),
                  (thickness, thickness, thickness), mat, parent=parent)
    return node

head = len(doc['nodes'])
doc['nodes'].append({'name': 'Head pose', 'children': [],
                     'translation': [0, 1.96, 0],
                     'rotation': [-math.sin(.12)*math.sin(-.045),
                                  math.sin(.12)*math.cos(-.045),
                                  math.cos(.12)*math.sin(-.045),
                                  math.cos(.12)*math.cos(-.045)]})
doc['nodes'][0]['children'].append(head)
solid('Body', (0, .79, 0), (.72, .57, .49), orange, 1, pear=.14)
solid('Cream chest', (0, .77, .385), (.53, .535, .16), cream, .92, pear=.10)
solid('Neck', (0, 1.3, 0), (.19, .043, .16), glass)
solid('Head', (0, 1.96, 0), (.87, .66, .75), orange, 1, parent=head)
solid('Face screen', (0, 1.96, .745), (.365, .365, .097), glass, parent=head)
tube('Cream face bezel', (0, 1.96, .678), .445, .103, cream, parent=head)
tube('Inner amber bezel', (0, 1.96, .751), .366, .012, amber, parent=head)
tube('Happy eye', (0, 1.916, .842), .17, .027, light, .15, math.pi-.15, parent=head)
for side in (-1, 1):
    solid('Ear cushion '+str(side), (side*.836, 1.97, -.025), (.13, .24, .24), cream, parent=head)
    solid('Ear amber cap '+str(side), (side*.946, 1.97, -.025), (.057, .168, .168), amber, parent=head)
solid('Left arm', (-.67, .80, .025), (.27, .31, .245), orange, .95, angle=-.4)
solid('Left mitten', (-.89, .66, .24), (.255, .255, .195), cream, .88, angle=-.22)
solid('Right raised arm', (.73, 1.0, .17), (.26, .35, .245), orange, .95, angle=-.65)
solid('Right waving mitten', (1.01, 1.26, .38), (.25, .28, .195), cream, .88, angle=-.2)
solid('Chest light housing', (0, .94, .534), (.18, .076, .034), amber, .65)
solid('Chest light', (0, .94, .567), (.13, .031, .013), light, .55)
solid('Hover rim', (0, .215, 0), (.33, .035, .29), amber)
solid('Hover glow', (0, .14, 0), (.29, .16, .255), light)

def add_fur(surface, count):
    name, points, triangles, normals, mat, center, parent = surface
    weights, total = [], 0
    for k in range(0, len(triangles), 3):
        a, b, c = [points[i] for i in triangles[k:k+3]]
        n = cross([b[j]-a[j] for j in range(3)], [c[j]-a[j] for j in range(3)])
        total += math.sqrt(sum(x*x for x in n))
        weights.append(total)
    vertices, fiber_normals, indices = [], [], []
    for _ in range(count):
        k = bisect_left(weights, rng.random()*total)*3
        ids = triangles[k:k+3]
        u, v = rng.random(), rng.random()
        if u+v > 1:
            u, v = 1-u, 1-v
        coefficients = [1-u-v, u, v]
        p = [sum(points[idx][j]*w for idx, w in zip(ids, coefficients)) for j in range(3)]
        n = normalize([sum(normals[idx][j]*w for idx, w in zip(ids, coefficients)) for j in range(3)])
        if name == 'Head' and p[2] > .40 and p[0]**2+p[1]**2 < .55**2:
            continue
        if name == 'Body' and p[2] > .25 and abs(p[0]) < .52:
            continue
        if name == 'Cream chest' and abs(p[0]) < .19 and abs(p[1]-.17) < .084 and p[2] > 0:
            continue
        tangent = normalize(cross(n, [0, 1, 0] if abs(n[1]) < .9 else [1, 0, 0]))
        bitangent = cross(n, tangent)
        length = rng.uniform(.014, .027)
        width = rng.uniform(.0007, .0011)
        lean = rng.uniform(-.7, .7)
        start = len(vertices)
        for j in range(3):
            a = j*2*math.pi/3
            radial = [tangent[q]*math.cos(a)+bitangent[q]*math.sin(a) for q in range(3)]
            vertices.append([p[q]+radial[q]*width-n[q]*.002 for q in range(3)])
            fiber_normals.append(normalize([n[q]*.85+radial[q]*.15 for q in range(3)]))
        vertices.append([p[q]+length*(n[q]+lean*tangent[q]) for q in range(3)])
        fiber_normals.append(n)
        for j in range(3):
            indices.extend([start+j, start+(j+1)%3, start+3])
    mesh(name+' short fibers', vertices, indices, fiber_materials[mat], center, fiber_normals, parent)

for surface in list(surfaces):
    name, points, triangles, normals, mat, center, parent = surface
    if mat not in (orange, cream):
        continue
    count = {'Head': 46000, 'Body': 18000, 'Cream chest': 14000,
             'Cream face bezel': 18000}.get(name, 6500)
    add_fur(surface, count)

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
path = OUT/'shera-main-v2.glb'
path.write_bytes(blob)
assert struct.unpack_from('<III', blob)[2] == len(blob)
assert len(doc['meshes']) >= 18
assert any('short fibers' in m['name'] for m in doc['meshes'])
assert all(math.isfinite(x) for a in doc['accessors'] for x in a['min']+a['max'])
for view in doc['bufferViews']:
    assert view['byteOffset'] % 4 == 0
    assert view['byteOffset']+view['byteLength'] <= len(data)
for m in doc['meshes']:
    p = m['primitives'][0]
    assert doc['accessors'][p['indices']]['max'][0] < doc['accessors'][p['attributes']['POSITION']]['count']
print(f'Created {path}: {len(blob):,} bytes, {len(doc["meshes"])} meshes; checks passed')

