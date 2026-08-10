// netlify/functions/stripe-webhook.js
//
// Cette fonction est appelée automatiquement par Stripe à chaque paiement réussi.
// Elle vérifie que l'appel vient bien de Stripe (signature secrète), récupère
// le détail de la commande (tableaux achetés, coordonnées, livraison), puis
// envoie un email complet à Sonia via Resend.

const crypto = require('crypto');

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => {
      const [k, v] = p.split('=');
      return [k, v];
    })
  );
  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_TO = process.env.NOTIFY_TO || 'contact@ateliers-sonia.fr';
  const RESEND_FROM = process.env.RESEND_FROM || 'notifications@ateliers-sonia.fr';

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  if (!WEBHOOK_SECRET || !verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Signature invalide.' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'JSON invalide.' };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'ignored' };
  }

  const session = stripeEvent.data.object;

  try {
    // Récupérer le détail des tableaux achetés
    const liRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` } }
    );
    const liData = await liRes.json();
    const items = (liData.data || [])
      .map(li => `- ${li.description} — ${(li.amount_total / 100).toFixed(2)} €`)
      .join('\n');

    const total = (session.amount_total / 100).toFixed(2);
    const customerEmail = session.customer_details?.email || 'Non renseigné';
    const customerName = session.customer_details?.name || session.shipping_details?.name || 'Non renseigné';
    const customerPhone = session.customer_details?.phone || 'Non renseigné';
    const shipping = session.shipping_details?.address;
    const shippingText = shipping
      ? `${shipping.line1 || ''} ${shipping.line2 || ''}, ${shipping.postal_code || ''} ${shipping.city || ''}, ${shipping.country || ''}`.trim()
      : null;
    const delivery = session.metadata?.mode_livraison || 'Non précisé';
    const pointRelais = session.metadata?.point_relais || '';

    const emailBody = `Nouvelle commande reçue sur Ateliers Sonia !

Tableaux commandés :
${items}

Total : ${total} €

--- Coordonnées de l'acheteur ---
Nom : ${customerName}
Email : ${customerEmail}
Téléphone : ${customerPhone}

--- Livraison ---
Mode : ${delivery}
${pointRelais ? 'Point relais choisi : ' + pointRelais : (shippingText ? 'Adresse : ' + shippingText : 'Adresse non renseignée')}

Référence de paiement Stripe : ${session.id}
`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: NOTIFY_TO,
        subject: `Nouvelle commande — ${total} €`,
        text: emailBody
      })
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return { statusCode: 502, body: `Échec envoi Resend: ${errText}` };
    }

    return { statusCode: 200, body: 'ok' };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
