// Lokaltyp och uppskattad LOA för ett arbetsställe (SCB): bransch (SNI 2025-avdelning) -> lokaltyp, och
// antal anställda (mitten av storleksklassen, minst 1) gånger yta per anställd. Räknas vid importen och
// sparas i arbetsstalle.lokaltyp och .loa_m2; kör importen igen om reglerna ändras.
// shortcut: grova tumregler för yta per anställd; ersätts av taxeringens lokalyta och byggnadernas ändamål.

// [lokaltyp, m² LOA per anställd], i visningsordning (klienten färgar efter platsen i listan).
export const LOKALTYPER = [['Kontor', 20], ['Butik', 40], ['Lager och logistik', 150], ['Industri', 100],
  ['Hotell och restaurang', 30], ['Vård och skola', 40], ['Övrigt', 30]];
const M2 = new Map(LOKALTYPER);
const AVDELNINGAR = { B: 'Industri', C: 'Industri', D: 'Industri', E: 'Industri', F: 'Industri', H: 'Lager och logistik',
  I: 'Hotell och restaurang', J: 'Kontor', K: 'Kontor', L: 'Kontor', M: 'Kontor', N: 'Kontor', O: 'Kontor', P: 'Kontor',
  Q: 'Vård och skola', R: 'Vård och skola' };
// Mitten av SCB:s storleksklass för antal anställda (kod 0–16).
const ANSTKL_MITT = [0, 0, 2.5, 7, 14.5, 34.5, 74.5, 150, 350, 750, 1250, 1750, 2500, 3500, 4500, 7500, 10000];

// Handeln (G) delas på detaljhandel (47) och partihandel.
export const lokaltyp = ({ avdelning, sni }) =>
  (avdelning === 'G' ? (sni?.startsWith('47') ? 'Butik' : 'Lager och logistik') : AVDELNINGAR[avdelning] ?? 'Övrigt');

export const loaM2 = (ae) => Math.max(1, ANSTKL_MITT[ae.anstkl] ?? 0) * M2.get(lokaltyp(ae));
