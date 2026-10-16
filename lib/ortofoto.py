"""Ritar ortofotorutor (256 px, WebP) ur Lantmäteriets COG-filer. Startas av server.mjs och lever
lika länge som servern, så att GDAL:s cache för filhuvuden och block återanvänds mellan rutorna.

En begäran per rad på stdin (JSON): {"id", "ut", "bounds": [xmin, ymin, xmax, ymax] i EPSG:3857,
"mal": rutans m/pixel, "bilder": [href, ...] äldst först}. Svarar med en rad: {"id", "ok": true} eller
{"id", "fel"}. Servern byter namn på filen. Inloggningen (GDAL_HTTP_USERPWD) kommer från servern i miljön.

    python3 lib/ortofoto.py --test   kör självtestet"""
import json
import re
import sys
import warnings

FINAST = 0.3  # m/pixel: åtagandet är högst ~0,3 m; finare bilder läses i en översikt
# Inloggningen skickas bara till Lantmäteriets egna servrar, oavsett vad registret innehåller.
TILLATEN = re.compile(r'^https://[a-z0-9-]+\.lantmateriet\.se/[^?#]+\.tif$')


def valj_niva(res, faktorer, mal):
    """Översikten att läsa (-1 = originalet, 0 = första översikten …) ur filens egna översikter:
    aldrig finare än FINAST, och den grövsta som inte är grövre än rutan (mal). None = ingen duger."""
    nivaer = [(-1, res)] + [(i, res * f) for i, f in enumerate(faktorer)]
    tillatna = [(n, r) for n, r in nivaer if r >= FINAST - 1e-9]
    if not tillatna:
        return None
    grova_nog = [(n, r) for n, r in tillatna if r <= mal]
    return max(grova_nog, key=lambda t: t[1])[0] if grova_nog else min(tillatna, key=lambda t: t[1])[0]


if '--test' in sys.argv:
    assert valj_niva(0.16, [2, 4, 8, 16, 32], 0.3) == 0      # zoom 18: 0,32 m
    assert valj_niva(0.16, [2, 4, 8, 16, 32], 0.7) == 1      # 0,64 m
    assert valj_niva(0.16, [2, 4, 8, 16, 32], 4.9) == 3      # zoom 14: 2,56 m
    assert valj_niva(0.16, [2, 4], 4.9) == 1                 # färre översikter: den grövsta som finns
    assert valj_niva(0.16, [3, 9], 0.3) == 0                 # andra faktorer: 0,48 m
    assert valj_niva(0.16, [], 0.3) is None                  # ingen översikt: originalet är för fint
    assert valj_niva(0.5, [2, 4], 0.3) == -1                 # originalet duger
    assert valj_niva(0.25, [2, 4], 0.3) == 0                 # 0,5 m, aldrig 0,25
    assert TILLATEN.match('https://dl1.lantmateriet.se/bild/data/orto/x.tif')
    assert not TILLATEN.match('https://dl1.lantmateriet.se.evil.example/x.tif')
    assert not TILLATEN.match('http://dl1.lantmateriet.se/x.tif')
    print('ok')
    sys.exit(0)

import numpy as np  # noqa: E402 (självtestet klarar sig utan rasterio)
import rasterio  # noqa: E402
from rasterio.crs import CRS  # noqa: E402
from rasterio.enums import Resampling  # noqa: E402
from rasterio.transform import from_bounds  # noqa: E402
from rasterio.warp import reproject  # noqa: E402

warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)
MERC = CRS.from_epsg(3857)
STORLEK = 256


def rita(req):
    transform = from_bounds(*req['bounds'], STORLEK, STORLEK)
    bild = np.zeros((4, STORLEK, STORLEK), np.uint8)
    for href in req['bilder']:  # äldst först: nyare skriver över där de täcker
        if not TILLATEN.match(href):
            raise ValueError(f'otillåten adress i registret: {href[:100]}')
        with rasterio.open(href) as src:
            niva = valj_niva(src.res[0], src.overviews(1), req['mal'])
        if niva is None:
            continue  # bara finare än 0,3 m finns: visas inte
        with rasterio.open(href, **({'OVERVIEW_LEVEL': niva} if niva >= 0 else {})) as src:
            lager = np.zeros((4, STORLEK, STORLEK), np.uint8)
            # Band 1–3 är RGB (ett fjärde band är infrarött); alfa 255 där bilden täcker.
            reproject(rasterio.band(src, [1, 2, 3]), lager, dst_transform=transform, dst_crs=MERC,
                      resampling=Resampling.bilinear, dst_alpha=4)
        tackt = lager[3] > 0
        bild[:, tackt] = lager[:, tackt]
    if not bild[3].any():
        return False
    ut = bild[:3] if bild[3].all() else bild
    with rasterio.open(req['ut'], 'w', driver='WEBP', width=STORLEK, height=STORLEK, count=len(ut), dtype='uint8',
                       QUALITY=80) as dst:
        dst.write(ut)
    return True


# GDAL_CACHEMAX i byte (rasterio skickar ett heltal rakt till GDALSetCacheMax64). Tidsgränserna gör att en
# hängande läsning avbryts i GDAL; servern dödar dessutom en arbetare som inte svarat på 30 s.
with rasterio.Env(GDAL_HTTP_AUTH='BASIC', GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                  CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MAX_RETRY='2', GDAL_HTTP_RETRY_DELAY='1',
                  GDAL_HTTP_CONNECTTIMEOUT='10', GDAL_HTTP_TIMEOUT='20',
                  VSI_CACHE=True, VSI_CACHE_SIZE=50_000_000, GDAL_CACHEMAX=128 * 1024 * 1024):
    for rad in sys.stdin:
        req = json.loads(rad)
        try:
            svar = {'id': req['id'], 'ok': True} if rita(req) else {'id': req['id'], 'fel': 'tom ruta'}
        except Exception as err:  # en trasig bild ska inte stoppa arbetaren
            svar = {'id': req['id'], 'fel': str(err)[:300]}
        sys.stdout.write(json.dumps(svar) + '\n')
        sys.stdout.flush()
