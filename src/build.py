import json, sys
from shapely.geometry import shape, LineString, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from pyproj import Transformer

SIMD = sys.argv[1]; OSM = sys.argv[2]; OUT = sys.argv[3]

CENTRE_PREFIX = ("Old Town", "Canongate", "Tollcross", "New Town", "Hillside",
                 "Meadows", "Deans Village", "South Gyle", "Ratho")

def tier(p):
    sd = (p['simdrank'] - 1) * 10 // 6976 + 1
    p['simddecile'] = sd
    cd = p['crimedecile']
    centre = p['dzname'].startswith(CENTRE_PREFIX)
    if cd == 1 and centre:
        return 'busy'            # visitor/commuter crime inflates per-resident rate
    if cd == 1 and sd <= 2:
        return 'exclude'
    if cd <= 2 and sd <= 3:
        return 'caution'
    if cd == 1:
        return 'busy' if centre else 'caution'
    return 'ok'

def rnd(coords):
    return [[round(x, 5), round(y, 5)] for x, y in coords]

def enc(coords):
    """delta-encode lon/lat at 1e-5 deg"""
    out = []; px = py = 0
    for x, y in coords:
        ix, iy = round(x * 1e5), round(y * 1e5)
        out += [ix - px, iy - py]; px, py = ix, iy
    return out

def enc_geom(g, tol):
    g = g.simplify(tol, preserve_topology=True)
    polys = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
    res = []
    for p in polys:
        if p.geom_type != 'Polygon' or p.is_empty: continue
        res.append([enc(p.exterior.coords)] + [enc(r.coords) for r in p.interiors])
    return res

# ---------- zones
simd = json.load(open(SIMD))
zones = []; zgeoms = []; counts = {}
for f in simd['features']:
    p = f['properties']; t = tier(p)
    g = shape(f['geometry']).buffer(0)
    zgeoms.append(g)
    counts[t] = counts.get(t, 0) + 1
    zones.append({'t': t, 'n': p['dzname'], 'code': p['dzcode'], 'pop': p['sape2017'],
                  'cr': p['crimerank'], 'cd': p['crimedecile'],
                  'rate': None if p['crimerate'] is None or p['crimerate'] < 0 else round(p['crimerate']),
                  'cnt': p['crimecount'], 'sd': p['simddecile'],
                  'g': enc_geom(g, 0.00003), '_g': g})
boundary = unary_union(zgeoms)
grp = {}
for z in zones: grp.setdefault(z['n'].rsplit(' - ',1)[0], []).append(z['_g'])
labels = []
for nm, gs in grp.items():
    u = unary_union(gs); pt = u.representative_point()
    labels.append([nm, round(pt.x,5), round(pt.y,5), round(area_km2(u) if False else u.area*1e4,2)])

# area stats in metres (BNG)
tr = Transformer.from_crs(4326, 27700, always_xy=True)
from shapely.ops import transform
def area_km2(g): return transform(tr.transform, g).area / 1e6
tot = area_km2(boundary)
areas = {}
for z in zones:
    areas[z['t']] = areas.get(z['t'], 0) + area_km2(z['_g'])
stats = {'total_km2': round(tot, 1), 'by_tier_km2': {k: round(v, 2) for k, v in areas.items()},
         'zones': counts}

# ---------- OSM
osm = json.load(open(OSM))['elements']
CLS = {'motorway': 0, 'trunk': 0, 'motorway_link': 0, 'trunk_link': 0, 'primary': 1, 'primary_link': 1,
       'secondary': 1, 'secondary_link': 1, 'tertiary': 2, 'unclassified': 3, 'residential': 3,
       'living_street': 3, 'pedestrian': 4}
tree = STRtree([z['_g'] for z in zones])
names = []; nidx = {}; roads = []; parks = []; water = []; rivers = []; coast = []
street_tiers = {}
RANK = {'ok': 0, 'busy': 1, 'caution': 2, 'exclude': 3}
for e in osm:
    t = e.get('tags', {})
    if e['type'] == 'way' and 'geometry' in e:
        co = [(n['lon'], n['lat']) for n in e['geometry']]
        if len(co) < 2: continue
        hw = t.get('highway')
        if hw in CLS:
            ls = LineString(co)
            if not boundary.buffer(0.003).intersects(ls): continue
            ls2 = ls.simplify(0.00002)
            nm = t.get('name') or t.get('ref') or ''
            if nm not in nidx: nidx[nm] = len(names); names.append(nm)
            roads.append([CLS[hw], nidx[nm], enc(ls2.coords)])
            if nm and hw != 'motorway':
                for i in tree.query(ls, predicate='intersects'):
                    z = zones[i]
                    # length of the street inside this zone, metres
                    L = transform(tr.transform, ls.intersection(z['_g'])).length
                    if L < 15: continue
                    s = street_tiers.setdefault(nm, {})
                    s[z['t']] = s.get(z['t'], 0) + L
                    zs = s.setdefault('_z', set()); zs.add(i)
        elif t.get('leisure') == 'park' or t.get('natural') == 'water':
            if co[0] != co[-1] or len(co) < 4: continue
            from shapely.geometry import Polygon
            pg = Polygon(co).buffer(0)
            if pg.is_empty or not boundary.buffer(0.01).intersects(pg): continue
            (parks if t.get('leisure') == 'park' else water).extend(enc_geom(pg, 0.00003))
        elif t.get('waterway') == 'river':
            rivers.append(enc(LineString(co).simplify(0.00003).coords))
        elif t.get('natural') == 'coastline':
            coast.append(enc(LineString(co).simplify(0.00003).coords))
    elif e['type'] == 'relation' and t.get('leisure') == 'park':
        from shapely.geometry import Polygon
        for m in e.get('members', []):
            if m.get('role') == 'outer' and m.get('geometry'):
                co = [(n['lon'], n['lat']) for n in m['geometry']]
                if len(co) >= 4 and co[0] == co[-1]:
                    parks.extend(enc_geom(Polygon(co).buffer(0), 0.00003))

streets = []
for nm, s in street_tiers.items():
    zs = sorted(s.pop('_z'))
    streets.append([nidx[nm], {k: round(v) for k, v in s.items()}, [int(i) for i in zs]])

FLAGS = [
    {'names': ['Pennywell Road', 'Pennywell Gardens'],
     'note': 'Repeated attacks on buses; Lothian suspended stops here more than once.',
     'src': 'https://www.midlothianadvertiser.co.uk/news/crime/pennywell-gardens-incident-police-hunt-youths-who-smashed-bus-window-forcing-suspension-of-five-lothian-services-3198700'},
]
for z in zones: del z['_g']
data = {'zones': zones, 'boundary': enc_geom(boundary, 0.00005), 'names': names, 'roads': roads,
        'parks': parks, 'water': water, 'rivers': rivers, 'coast': coast, 'streets': streets,
        'flags': FLAGS, 'labels': labels, 'stats': stats}
s = json.dumps(data, separators=(',', ':'))
open(OUT, 'w').write('window.MAPDATA=' + s + ';')
print(len(s) / 1e6, 'MB'); print(json.dumps(stats, indent=1))
print('roads', len(roads), 'streets', len(streets), 'parks', len(parks), 'water', len(water))
