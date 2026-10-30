// Office hours, in the city's own time zone.

// Is City Hall closed right now, by the city's own clock and office hours?
export function afterHours(city, at = new Date()) {
  const s = city.settings;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: city.timezone || 'America/Chicago', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const toMin = (hm) => { const [h, mm] = String(hm).split(':').map(Number); return h * 60 + (mm || 0); };
  return !(s.openDays || [1, 2, 3, 4, 5]).includes(day) || minutes < toMin(s.openTime || '08:00') || minutes >= toMin(s.closeTime || '17:00');
}
