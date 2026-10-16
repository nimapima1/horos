"""Ritar ortofotorutor (256 px, WebP) ur Lantmäteriets COG-filer. Startas av server.mjs och lever
lika länge som servern, så att GDAL:s cache för filhuvuden och block återanvänds mellan rutorna.

En begäran per rad på stdin (JSON): {"id", "ut", "bounds": [xmin, ymin, xmax, ymax] i EPSG:3857,
"bilder": [{"href", "niva"}] äldst först}. Svarar med en rad: {"id", "ok": true} eller {"id", "fel"}.
Inloggningen (GDAL_HTTP_USERPWD) kommer från servern i miljön."""
import json
import os
import sys
import warnings

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject

warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)
MERC = CRS.from_epsg(3857)
STORLEK = 256


def rita(req):
    transform = from_bounds(*req['bounds'], STORLEK, STORLEK)
    bild = np.zeros((4, STORLEK, STORLEK), np.uint8)
    for b in req['bilder']:  # äldst först: nyare skriver över där de täcker
        oppna = {'OVERVIEW_LEVEL': b['niva']} if b['niva'] >= 0 else {}
        with rasterio.open(b['href'], **oppna) as src:
            lager = np.zeros((4, STORLEK, STORLEK), np.uint8)
            # Band 1–3 är RGB (ett fjärde band är infrarött); alfa 255 där bilden täcker.
            reproject(rasterio.band(src, [1, 2, 3]), lager, dst_transform=transform, dst_crs=MERC,
                      resampling=Resampling.bilinear, dst_alpha=4)
        tackt = lager[3] > 0
        bild[:, tackt] = lager[:, tackt]
    if not bild[3].any():
        return False
    ut = bild[:3] if bild[3].all() else bild
    tmp = req['ut'] + '.tmp'
    with rasterio.open(tmp, 'w', driver='WEBP', width=STORLEK, height=STORLEK, count=len(ut), dtype='uint8',
                       QUALITY=80) as dst:
        dst.write(ut)
    os.replace(tmp, req['ut'])
    return True


with rasterio.Env(GDAL_HTTP_AUTH='BASIC', GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                  CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MAX_RETRY='3', GDAL_HTTP_RETRY_DELAY='1',
                  VSI_CACHE=True, VSI_CACHE_SIZE=50_000_000, GDAL_CACHEMAX=256):
    for rad in sys.stdin:
        req = json.loads(rad)
        try:
            svar = {'id': req['id'], 'ok': True} if rita(req) else {'id': req['id'], 'fel': 'tom ruta'}
        except Exception as err:  # en trasig bild ska inte stoppa arbetaren
            svar = {'id': req['id'], 'fel': str(err)[:300]}
        sys.stdout.write(json.dumps(svar) + '\n')
        sys.stdout.flush()
