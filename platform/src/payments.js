// Card payments for anything a resident pays for online: license fees, permit fees, and so on.
//
// Online payment is offered only when PAYMENTS_PROVIDER is set. Without it, residents are told to pay at City Hall and
// staff record cash and check payments. No card processor is connected yet, so the only provider is 'test', set for local
// development and staging only (.dev.vars, wrangler.jsonc env.staging). It works like a processor's test mode: it accepts
// the standard test card numbers, declines the standard decline number, and refuses every other card, so nobody is ever
// told a real card was charged. Never set it to 'test' in production: anyone could mark a fee paid with a test card.
// To connect Stripe, add a provider here (PaymentIntents on the server, Stripe Elements in the browser) and set
// PAYMENTS_PROVIDER; callers only ever see { ok, id, last4, brand } or { ok: false, error }.
//
// Card numbers are never stored or logged. Only the last four digits and the brand are kept, with the payment id.

export const paymentsProvider = (env) => env.PAYMENTS_PROVIDER || null;
export const paymentsInfo = (env) => ({ enabled: !!paymentsProvider(env), provider: paymentsProvider(env), testMode: paymentsProvider(env) === 'test' });

const TEST_CARDS = {
  '4242424242424242': { brand: 'Visa' }, '4000056655665556': { brand: 'Visa' }, '5555555555554444': { brand: 'Mastercard' },
  '2223003122003222': { brand: 'Mastercard' }, '378282246310005': { brand: 'American Express' }, '6011111111111117': { brand: 'Discover' },
  '4000000000000002': { brand: 'Visa', decline: 'Your card was declined.' },
  '4000000000009995': { brand: 'Visa', decline: 'Your card has insufficient funds.' },
};

function luhn(n) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Checks what the resident typed. Returns { number, last4 } or { error }.
function readCard(card = {}) {
  const number = String(card.number || '').replace(/[\s-]/g, '');
  const [mm, yy] = String(card.exp || '').split(/\s*\/\s*/).map(Number);
  if (!/^\d{13,19}$/.test(number) || !luhn(number)) return { error: 'Check the card number.' };
  const now = new Date();
  const year = yy < 100 ? 2000 + yy : yy;
  if (!mm || mm > 12 || !year || year < now.getFullYear() || (year === now.getFullYear() && mm < now.getMonth() + 1)) return { error: 'Check the expiration date (MM/YY).' };
  if (!/^\d{3,4}$/.test(String(card.cvc || ''))) return { error: 'Check the security code.' };
  return { number, last4: number.slice(-4) };
}

const testId = (p) => `${p}_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

export async function charge(env, { amountCents, card, description }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'There is nothing to pay.' };
  const c = readCard(card);
  if (c.error) return { ok: false, error: c.error };
  if (paymentsProvider(env) !== 'test') return { ok: false, error: 'Online payments are not available right now. Please pay at City Hall.' };
  const t = TEST_CARDS[c.number];
  if (!t) return { ok: false, error: 'Card payments are in test mode, so this card was not charged. Use a test card such as 4242 4242 4242 4242, or pay at City Hall.' };
  if (t.decline) return { ok: false, error: t.decline, declined: true };
  console.log('test payment', amountCents, description);
  return { ok: true, id: testId('pay'), last4: c.last4, brand: t.brand, provider: 'test', amountCents };
}

export async function refund(env, { id, amountCents }) {
  if (!id || !amountCents) return { ok: false, error: 'Nothing to refund' };
  if (!id.startsWith('pay_test_')) return { ok: false, error: 'This payment was not made through the test provider' };
  return { ok: true, id: testId('re'), amountCents };
}
