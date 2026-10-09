// Metodsidan: visar datum för senaste uppdatering och aktiverar GeoJSON-nedladdningen om den är tillåten.
fetch('api/status').then((r) => r.json()).then((s) => {
  if (s.byggd) {
    const d = new Date(`${s.byggd.replace(' ', 'T')}Z`);
    const el = document.getElementById('byggd');
    el.textContent += ` Senast uppdaterad ${d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' })}`
      + ` · ${s.fastigheter.toLocaleString('sv-SE')} fastigheter.`;
  }
  if (s.export?.geojson) document.getElementById('dl-geojson').removeAttribute('aria-disabled');
}).catch(() => {});
