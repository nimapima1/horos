// Bladet nedtill på mobilen (kopplas in i app.js): fjäder, rörelsemängd och gummiband som i Apples
// "Designing Fluid Interfaces". Bara deklarationer, utan DOM; testas i test/ark.test.mjs.

// Hur långt rörelsen fortsätter med farten v (px/s) om den bromsas som en rullning.
const projicera = (v, broms = 0.998) => (v / 1000) * broms / (1 - broms);

// Motstånd bortom kanten: ju längre ut, desto mindre följer bladet med (aldrig längre än storlek).
const gummiband = (over, storlek, k = 0.55) => (over * storlek * k) / (storlek + k * Math.abs(over));

// Läget närmast dit rörelsen pekar, inte närmast där fingret släppte.
function narmastLage(lagen, y, v) {
  const mal = y + projicera(v);
  return lagen.reduce((a, b) => (Math.abs(b - mal) < Math.abs(a - mal) ? b : a));
}

// Ett steg (dt sekunder) för en fjäder: dämpning 1 = ingen studs, svar = ungefär tiden fram (s).
function fjaderSteg({ x, v }, mal, dt, dampning = 1, svar = 0.3) {
  const w = 2 * Math.PI / svar;
  const nyV = v + (-w * w * (x - mal) - 2 * dampning * w * v) * dt;
  return { x: x + nyV * dt, v: nyV };
}
