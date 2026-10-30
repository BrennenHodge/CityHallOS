// Online services a city runs on other sites, such as paying a water bill. Staff list each one in Settings with its
// direct link and the words residents use for it. The AI always has the links (in the city profile), and a question that
// uses those words gets the link as a button in the website chat and in the text message reply.

const MAX = 20;

// What staff typed in Settings, checked: a name, an https link, and comma-separated words or phrases.
export function cleanServices(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => ({
    label: String(x?.label || '').trim().slice(0, 60),
    url: String(x?.url || '').trim().slice(0, 500),
    words: String(x?.words || '').split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 30).join(', '),
  })).filter((x) => x.label && /^https:\/\/[^\s<>"']+$/i.test(x.url)).slice(0, MAX);
}

const phrases = (svc) => svc.words.split(',').map((w) => w.trim()).filter(Boolean);
const has = (text, phrase) => new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}($|[^a-z0-9])`, 'i').test(text);

// The services a resident's message is about, at most two.
export function matchServices(settings, text) {
  const t = String(text || '');
  return (settings.services || []).filter((svc) => phrases(svc).some((p) => has(t, p))).slice(0, 2).map(({ label, url }) => ({ label, url }));
}

// For the city profile the AI always sees.
export function servicesProfile(settings) {
  const list = settings.services || [];
  return list.length ? ` Online services, with their direct links: ${list.map((x) => `${x.label}: ${x.url}`).join('; ')}.` : '';
}
