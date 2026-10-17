/**
 * Vercel Function: POST /api/casting
 * Riceve e valida le candidature prima di inoltrarle a Google Apps Script.
 * CASTING_GOOGLE_SCRIPT_URL e CASTING_SHARED_SECRET vanno impostati SOLO su Vercel.
 */
import { randomUUID } from 'node:crypto';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

const string = (value, max = 3000) => typeof value === 'string' ? value.trim().slice(0, max + 1) : '';
const validUrl = (value) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname); }
  catch { return false; }
};
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const validPhone = (s) => /^\+?[0-9\s().-]+$/.test(s) && s.replace(/\D/g, '').length >= 7 && s.replace(/\D/g, '').length <= 15 && s.length <= 40;
const allowedRoles = ['musicista', 'cantante'];

export async function POST(request) {
  // Le richieste inviate da browser di origini diverse non vengono accettate.
  const origin = request.headers.get('origin');
  const allowed = (process.env.CASTING_ALLOWED_ORIGINS || 'https://carlofeola.it,https://www.carlofeola.it')
    .split(',').map(x => x.trim()).filter(Boolean);
  // Permette di testare il sito sul suo indirizzo ufficiale .vercel.app senza configurazioni aggiuntive.
  // Il confronto avviene con l'host reale della richiesta, non con un prefisso generico *.vercel.app.
  const siteOrigin = new URL(request.url).origin;
  if (origin && origin !== siteOrigin && !allowed.includes(origin)) {
    return json({ ok: false, error: 'Origine non autorizzata.' }, 403);
  }

  const scriptUrl = process.env.CASTING_GOOGLE_SCRIPT_URL;
  const sharedSecret = process.env.CASTING_SHARED_SECRET;
  if (!scriptUrl || !sharedSecret || sharedSecret.length < 32) {
    return json({ ok: false, error: 'Il servizio candidature non è ancora configurato.' }, 503);
  }
  try {
    const dest = new URL(scriptUrl);
    if (dest.protocol !== 'https:' || dest.hostname !== 'script.google.com' ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(dest.pathname)) throw Error('Endpoint Google non valido');
  } catch { return json({ ok: false, error: 'Configurazione del servizio non valida.' }, 503); }

  const reportedSize = Number(request.headers.get('content-length') || 0);
  if (reportedSize > 12000) return json({ ok: false, error: 'Candidatura troppo lunga.' }, 413);
  let data;
  try {
    const raw = await request.text();
    if (raw.length > 12000) return json({ ok: false, error: 'Candidatura troppo lunga.' }, 413);
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
  } catch { return json({ ok: false, error: 'Formato della richiesta non valido.' }, 400); }

  // Campo-trappola invisibile ai candidati (non sufficiente da solo come anti-spam).
  if (data.website_confirmation) return json({ ok: true });

  const profilo = Array.isArray(data.profilo_artistico) ? data.profilo_artistico : [];
  const links = Array.isArray(data.link_performance) ? data.link_performance : [];
  const nome = string(data.nome, 80);
  const cognome = string(data.cognome, 80);
  const nomeArte = string(data.nome_arte, 120);
  const strumenti = string(data.strumenti, 300);
  const esperienze = string(data.presentazione_esperienze, 3000);
  const email = string(data.email, 254);
  const telefono = string(data.telefono, 40);
  const origine = 'carlofeola.it/casting';
  const privacy = data.privacy_presa_visione === true;

  if (!nome || !cognome || nome.length > 80 || cognome.length > 80 || nomeArte.length > 120 ||
      strumenti.length > 300 || esperienze.length > 3000 || !validEmail(email) || !validPhone(telefono) ||
      !privacy || profilo.length < 1 || profilo.length > 2 ||
      new Set(profilo).size !== profilo.length || profilo.some(x => !allowedRoles.includes(x)) ||
      links.length < 1 || links.length > 8 || links.some(x => typeof x !== 'string' || x.length > 1200 || !validUrl(x))) {
    return json({ ok: false, error: 'Controlla i dati obbligatori e riprova.' }, 422);
  }

  const id = /^[0-9a-f-]{36}$/i.test(data.id_candidatura || '') ? data.id_candidatura : randomUUID();
  const payload = { secret: sharedSecret, id, candidatura: {
    nome, cognome, nome_arte: nomeArte, profilo_artistico: profilo,
    strumenti, link_performance: links, presentazione_esperienze: esperienze,
    email, telefono, privacy_presa_visione: true, origine,
  } };

  try {
    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error('Google ha restituito HTTP ' + response.status);
    const answerText = await response.text();
    let answer;
    try { answer = JSON.parse(answerText); } catch { throw new Error('Risposta non JSON da Google'); }
    if (answer.ok !== true || answer.id !== id) throw new Error('Risposta Google non valida');
    return json({ ok: true });
  } catch (error) {
    // Non loggare dati personali o segreti.
    console.error('Casting: errore di consegna al sistema Google:', error?.name || 'error');
    return json({ ok: false, error: 'Invio non confermato. Riprova tra qualche minuto.' }, 502);
  }
}

export function GET() { return json({ ok: false, error: 'Metodo non consentito.' }, 405); }
