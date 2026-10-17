"""Build a region pack (regions/<id>.json) for the hide-and-seek app.

Inputs: the zones-map data.js (boundary, safety zones, sketch basemap), OSM extracts
for places / areas / stops, and a wards GeoJSON.
"""
import json, sys, math, collections
from shapely.geometry import shape, Point, Polygon, LineString, MultiPolygon
from shapely.ops import unary_union, linemerge, polygonize
from shapely.strtree import STRtree

U = sys.argv[1]          # folder with osm_*.json + wards
DATAJS = sys.argv[2]     # zones map data.js
OUT = sys.argv[3]

D = json.loads(open(DATAJS).read()[len('window.MAPDATA='):-1])

def dec(a):
    o = []; x = y = 0
    for i in range(0, len(a), 2):
        x += a[i]; y += a[i + 1]; o.append((x / 1e5, y / 1e5))
    return o

def enc(coords):
    out = []; px = py = 0
    for x, y in coords:
        ix, iy = round(x * 1e5), round(y * 1e5)
        out += [ix - px, iy - py]; px, py = ix, iy
    return out

def enc_geom(g, tol=0.00004):
    g = g.simplify(tol, preserve_topology=True)
    polys = [g] if g.geom_type == 'Polygon' else [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']
    return [[enc(p.exterior.coords)] + [enc(r.coords) for r in p.interiors] for p in polys if not p.is_empty]

# local metric for areas / distances
LAT0 = 55.94
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110574
def m_dist(a, b):  # (lon,lat)
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)
def area_m2(g):
    from shapely import affinity
    return affinity.scale(g, KX, KY, origin=(0, 0)).area

boundary = unary_union([Polygon(dec(r[0]), [dec(h) for h in r[1:]]).buffer(0) for r in D['boundary']])
bnd_near = boundary.buffer(0.004)
# Anything outside the play area is treated as if it does not exist (40 m tolerance for coastal/edge features)
INB = boundary.buffer(0.0005)

# ---------------- grid
minx, miny, maxx, maxy = boundary.bounds
pad_lon, pad_lat = 600 / KX, 600 / KY
minx -= pad_lon; maxx += pad_lon; miny -= pad_lat; maxy += pad_lat
CELL = 30
nx = math.ceil((maxx - minx) * KX / CELL); ny = math.ceil((maxy - miny) * KY / CELL)
grid = {'lon0': round(minx, 6), 'lat1': round(maxy, 6), 'kx': round(KX, 3), 'ky': KY, 'cell': CELL, 'nx': nx, 'ny': ny}

# ---------------- places
def center(e):
    if 'center' in e: return (e['center']['lon'], e['center']['lat'])
    if 'lon' in e: return (e['lon'], e['lat'])
    return None

CATS = [
    # id, label, matcher(tags)->bool
    ('museum', 'Museum', lambda t: t.get('tourism') == 'museum'),
    ('library', 'Library', lambda t: t.get('amenity') == 'library'),
    ('cinema', 'Cinema', lambda t: t.get('amenity') == 'cinema'),
    ('theatre', 'Theatre', lambda t: t.get('amenity') == 'theatre'),
    ('hospital', 'Hospital', lambda t: t.get('amenity') == 'hospital'),
    ('university', 'University', lambda t: t.get('amenity') == 'university'),
    ('stadium', 'Stadium', lambda t: t.get('leisure') == 'stadium'),
    ('golf', 'Golf course', lambda t: t.get('leisure') == 'golf_course'),
    ('castle', 'Castle', lambda t: t.get('historic') == 'castle'),
    ('hill', 'Hill / summit', lambda t: t.get('natural') in ('peak', 'hill')),
    ('rail', 'Rail station', lambda t: t.get('railway') == 'station'),
    ('tram', 'Tram stop', lambda t: t.get('railway') == 'tram_stop'),
    ('consulate', 'Consulate', lambda t: t.get('office') == 'diplomatic'),
]
places = json.load(open(U + '/osm_places.json'))['elements']
cats = []
for cid, label, fn in CATS:
    items = []
    for e in places:
        t = e.get('tags', {})
        if not fn(t) or not t.get('name'): continue
        c = center(e)
        if not c: continue
        if cid == 'rail' and t.get('station') in ('subway', 'light_rail'): continue
        if cid == 'rail' and ('halt' in t['name'].lower() and t.get('usage') == 'tourism'): continue
        items.append([e['type'][0] + str(e['id']), t['name'], round(c[1], 5), round(c[0], 5)])
    # merge same-name items closer than 300 m (node + building duplicates, tram stop pairs)
    merged = []
    for it in items:
        dup = next((m for m in merged if m[1] == it[1] and m_dist((m[3], m[2]), (it[3], it[2])) < 300), None)
        if not dup: merged.append(it)
    merged.sort(key=lambda r: r[1])
    cats.append({'id': cid, 'label': label, 'kind': 'point', 'items': merged})


# ---------------- curation: drop entries that don't fit the category, fix confusing names
DROP = {
  'museum': ['Museum Collections Centre', 'The Spirit of Leithers', 'Trinity Apse', 'Talbot Rice Gallery', "The King's Gallery",
             "One O'Clock Gun Exhibition", 'Prisoners of War Museum', 'The Royal Scots Dragoon Guards Museum', 'The Royal Scots Regimental Museum',
             'Anatomical Museum', 'Heriot Watt Museum', 'Cockburn Geological Museum'],
  'library': ['Advocates Library', 'Artiscience Library', 'Cameron Smail Library', "Central Children's Library", 'Edinburgh College of Art Library',
              'Edinburgh Law School Library', 'Edinburgh Napier Merchiston Library', 'Edinburgh University Library', 'Library of Mistakes',
              'Moray House Library', 'National Library of Scotland, Causewayside - Maps Reading Room', 'New College Library',
              'Noreen and Kenneth Murray Library', 'Playfair Library', 'RBGE Herbarium & Library', 'Sighthill Learning Resource Centre (LRC)',
              'Signet Library', 'The Lex Davidson Library', 'West Lothian Local History Library'],
  'cinema': ['The Fraser Centre', 'Scotsman Picturehouse'],
  'theatre': ['Assembly Rooms', 'General Assembly Hall', 'Gordon Aikman Lecture Theatre', 'Monkey Barrel 2', 'Monkey Barrel Comedy', 'Monkey Barrel MB3 MB4',
              'Old College Quad', 'Open Air Theatre', 'Quincentenary Hall', 'Reid Concert Hall', 'Ross Theatre', "St Cecilia's Hall", 'Symposium Hall',
              'The Hub', 'The Prince Philip Building', "The Queen's Hall", 'The Stand Comedy Club', 'The Studio', 'Usher Hall'],
  'hospital': ['Chalmers Centre', 'Findlay House', 'Lauriston Building', 'Leith Community Treatment Centre', 'Woodburn House NHS', 'The Esk Centre'],
  'university': ['1894 Building', "Adam Smith's Panmure House", 'Communications & Marketing', 'Gillis Centre', 'Institute of Design Informatics',
                 'Old College (University of Edinburgh)', 'Royal College of Physicians of Edinburgh', 'School of Informatics',
                 'The Royal College of Surgeons of Edinburgh', 'The University Of Edinburgh 13-15 South College Street',
                 'University of Edinburgh - Edinburgh Futures Institute', 'University of Edinburgh - High School Yards',
                 'University of Edinburgh - Pleasance', 'University of Edinburgh Bioquarter', 'Edinburgh Napier University'],
  'stadium': ['Centre Court', 'Goldenacre', 'Meggetland Sports Pavilion', 'Edinburgh Academical Football Club', 'Newtown Park', 'Prestonfield'],
  'golf': ['Houston Driving Range', "King's Acre Golf Driving Range", 'Pitch and Putt', 'Beginners Golf Course', 'Braid Hills Golf Centre',
           'Bruntsfield Links Short Hole Golf Course', 'Wee Braids Golf Course', 'West Course'],
  'castle': ['Calder House', 'House of the Binns', 'Palace of Holyroodhouse', 'Linlithgow Palace'],
  'hill': ['Salisbury Crags', 'Dunsapie Crag', ('Crow Hill', 55.943), 'The Nether Hill', 'Whinny Hill', 'Haggis Knowe', 'Buckstone Snab',
           'Greendykes Bing', 'Greendykes Bing South Top', 'North Philpstoun Bing', 'South Philpstoun Bing'],
  'rail': ['Drumshoreland', "Bo'ness"],
  'consulate': ['India Visa and Consular Services', 'Taipei Representative Office in the UK'],
  'park': ['Parade Ground', 'The Field', 'The Lawn', 'The Knoll', 'Parkside', 'Old Norton Quarry (filled)', 'Pikes Pool', 'Saughton Park Gardens',
           'Harrison Park West', 'Newhailes House & Gardens'],
  'water': ['Duck Pond'],
}
RENAME = {
  'cinema': {'ODEON MULTIPLEX CINEMA': 'Odeon (Wester Hailes)', ('Odeon', 55.935): 'Odeon (Fort Kinnaird)', ('Odeon', 55.946): 'Odeon (Lothian Road)', ('Vue', 55.883): 'Vue (Livingston)',
             ('Vue', 55.956): 'Vue (Omni Centre)', ('Vue', 55.981): 'Vue (Ocean Terminal)', 'Everyman': 'Everyman (St James Quarter)', 'Cineworld': 'Cineworld (Fountain Park)'},
  'golf': {'East Course': 'Dalmahoy Golf Club', 'Bruntsfield Links': 'Bruntsfield Links Golfing Society', 'Deer Park': 'Deer Park Golf Club',
           'Halkett Course': 'Dunfermline Golf Club (Halkett)', 'Pitfirrane Course': 'Dunfermline Golf Club (Pitfirrane)'},
  'hill': {'Riccarton Hill Cairn': 'Riccarton Hill', ('Fala Knowe', 55.841): 'Fala Knowe (Glencorse)', ('Fala Knowe', 55.876): 'Fala Knowe (Castlelaw)',
           ('Crow Hill', 56.050): 'Crow Hill (Fife)'},
  'consulate': {'Embassy of Romania': 'Consulate of Romania'},
  'park': {('King George V Park', 55.894): 'King George V Park (Currie)', ('King George V Park', 55.961): 'King George V Park (Canonmills)',
           ('King George V Park', 55.877): 'King George V Park (Bonnyrigg)', ('Meadowfield Park', 55.946, -3.326): 'Meadowfield Park (Ratho Station)',
           ('Meadowfield Park', 55.946, -3.146): 'Meadowfield Park (Duddingston)', 'Harrison Park East': 'Harrison Park'},
}
ADD = {'stadium': [['x-meadowbank', 'Meadowbank Stadium', 55.9563, -3.1562]]}
def _match(key, it):
    if isinstance(key, str): return it[1] == key
    nm, la = key[0], key[1]
    return it[1] == nm and abs(it[2] - la) < 0.0015 and (len(key) < 3 or abs(it[3] - key[2]) < 0.0015)
CURATED = []
def curate(c):
    drops, ren = DROP.get(c['id'], []), RENAME.get(c['id'], {})
    keep = []
    for it in c['items']:
        if any(_match(k, it) for k in drops): CURATED.append(('drop', c['id'], it[1])); continue
        for k, nm in ren.items():
            if _match(k, it): CURATED.append(('rename', c['id'], it[1] + ' -> ' + nm)); it[1] = nm; break
        keep.append(it)
    for a in ADD.get(c['id'], []): keep.append(a); CURATED.append(('add', c['id'], a[1]))
    unused = [k for k in drops if not any(x[0] == 'drop' and x[1] == c['id'] and (x[2] == (k if isinstance(k, str) else k[0])) for x in CURATED)]
    if unused: print('WARN unmatched drops', c['id'], unused)
    keep.sort(key=lambda r: r[1]); c['items'] = keep
for c in cats:
    before = len(c['items'])
    c['items'] = [i for i in c['items'] if INB.contains(Point(i[3], i[2]))]
    print('  outside dropped', c['id'], before - len(c['items']))
for c in cats: curate(c)

# ---------------- areas: parks, water
areas = json.load(open(U + '/osm_areas.json'))['elements']
def area_geom(e):
    if e['type'] == 'way':
        co = [(n['lon'], n['lat']) for n in e.get('geometry', [])]
        if len(co) >= 4 and co[0] == co[-1]: return Polygon(co).buffer(0)
        return None
    lines = [LineString([(n['lon'], n['lat']) for n in m['geometry']]) for m in e.get('members', [])
             if m.get('role') == 'outer' and m.get('geometry') and len(m['geometry']) > 1]
    if not lines: return None
    polys = list(polygonize(linemerge(lines)))
    return unary_union(polys).buffer(0) if polys else None

def area_cat(cid, label, test, min_ha):
    feats = []
    for e in areas:
        t = e.get('tags', {})
        if not test(t): continue
        g = area_geom(e)
        if g is None or g.is_empty: continue
        g = g.intersection(INB)
        if g.is_empty or g.area == 0: continue
        feats.append([t['name'], g, e['type'][0] + str(e['id'])])
    # merge same-name features within ~200 m
    groups = []
    for nm, g, oid in feats:
        grp = next((x for x in groups if x[0] == nm and x[1].distance(g) < 0.003), None)
        if grp: grp[1] = unary_union([grp[1], g])
        else: groups.append([nm, g, oid])
    items = []
    for nm, g, oid in groups:
        if area_m2(g) < min_ha * 1e4: continue
        p = g.representative_point()
        items.append([oid, nm, round(p.y, 5), round(p.x, 5), enc_geom(g, 0.00003)])
    items.sort(key=lambda r: r[1])
    return {'id': cid, 'label': label, 'kind': 'area', 'items': items}

NOT_PARK = ('Engineering Centre', 'Bike Track', 'Edmonstone House', 'Jupiter Artland', 'Farm Park')
cats.append(area_cat('park', 'Park', lambda t: t.get('leisure') == 'park' and not any(w in t['name'] for w in NOT_PARK), 1.0))
NOT_WATER = ('Harbour', 'Lock', 'Marsh')
cats.append(area_cat('water', 'Loch or pond', lambda t: t.get('natural') == 'water' and t.get('water') not in ('river', 'canal', 'stream', 'wastewater', 'lock', 'harbour') and not any(w in t['name'] for w in NOT_WATER), 0.3))

for c in cats:
    if c['id'] in ('park', 'water'): curate(c)

# wards (matching only)
wards = json.load(open(U + '/edinburgh-wards-named.geojson'))['features']
wi = []
for f in wards:
    g = shape(f['geometry']).buffer(0)
    p = g.representative_point()
    wi.append([f['properties']['id'], f['properties']['name'], round(p.y, 5), round(p.x, 5), enc_geom(g, 0.00005)])
wi.sort(key=lambda r: r[1])
cats.append({'id': 'ward', 'label': 'Council ward', 'kind': 'area', 'only': 'match', 'items': wi})

# coastline (measuring only) — one line feature
coast_lines = [LineString(dec(c)) for c in D['coast']]
coast_lines = [l.intersection(boundary.buffer(0.004)) for l in coast_lines]  # the coast runs along the boundary itself
cl = []
for l in coast_lines:
    for part in ([l] if l.geom_type == 'LineString' else getattr(l, 'geoms', [])):
        if part.geom_type == 'LineString' and len(part.coords) > 1: cl.append(enc(part.simplify(0.00003).coords))
cats.append({'id': 'coast', 'label': 'Coastline', 'kind': 'line', 'only': 'measure',
             'items': [['coast', 'Firth of Forth coast', 55.98, -3.2, cl]]})

# ---------------- stops: merge platforms with same name within 150 m; keep those in the city
stops_raw = json.load(open(U + '/osm_stops.json'))['elements']
clusters = []  # [name, mode, [lons], [lats], ids]
for e in sorted(stops_raw, key=lambda e: e['id']):
    t = e.get('tags', {})
    tram = t.get('railway') == 'tram_stop' or t.get('tram') == 'yes'
    nm = (t.get('name') or t.get('ref') or '').strip()
    if not nm: nm = 'Unnamed stop'
    mode = 'tram' if tram else 'bus'
    pt = (e['lon'], e['lat'])
    if not INB.contains(Point(pt)): continue
    c = next((c for c in clusters if c[0] == nm and c[1] == mode and m_dist((sum(c[2]) / len(c[2]), sum(c[3]) / len(c[3])), pt) < 150), None)
    if c: c[2].append(pt[0]); c[3].append(pt[1])
    else: clusters.append([nm, mode, [pt[0]], [pt[1]], 'n' + str(e['id'])])
stops = []
for nm, mode, lons, lats, sid in clusters:
    if not boundary.contains(Point(sum(lons) / len(lons), sum(lats) / len(lats))): continue  # stops: strictly inside the play area
    stops.append([sid, nm, round(sum(lats) / len(lats), 5), round(sum(lons) / len(lons), 5), mode])
stops.sort(key=lambda s: (s[1], s[2]))

# ---------------- safety zones (non-ok only), sketch basemap
zones = [{'t': z['t'], 'n': z['n'], 'g': z['g'], 'cr': z['cr'], 'sd': z['sd'], 'rate': z['rate']} for z in D['zones'] if z['t'] != 'ok']

pack = {
    'id': 'edinburgh', 'name': 'Edinburgh', 'center': [55.945, -3.20], 'zoom': 12,
    'note': 'City of Edinburgh council area. Safety tiers from SIMD 2020; places and stops from OpenStreetMap.',
    'grid': grid, 'boundary': D['boundary'], 'zones': zones, 'flags': D['flags'],
    'sketch': {'roads': D['roads'], 'names': D['names'], 'parks': D['parks'], 'water': D['water'], 'rivers': D['rivers'], 'coast': D['coast'], 'labels': D['labels']},
    'stops': stops, 'cats': cats,
}
s = json.dumps(pack, separators=(',', ':'), ensure_ascii=False)
open(OUT, 'w').write(s)
print('pack MB', round(len(s.encode()) / 1e6, 2), 'grid', nx, 'x', ny, '=', nx * ny)
print('stops', len(stops), collections.Counter(s[4] for s in stops), 'raw', len(stops_raw))
for c in cats: print(' ', c['id'], len(c['items']))
