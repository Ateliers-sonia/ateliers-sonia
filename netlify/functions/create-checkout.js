// netlify/functions/create-checkout.js
//
// Cette fonction crée une session de paiement Stripe à la volée,
// à partir des articles envoyés par le site (un seul tableau ou plusieurs).
// Elle n'a besoin d'aucune dépendance externe : elle appelle directement
// l'API REST de Stripe avec la clé secrète stockée dans les variables
// d'environnement Netlify (jamais dans le code).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Clé Stripe non configurée sur le serveur.' })
    };
  }

  try {
    const { items, delivery, deliveryDetail } = JSON.parse(event.body || '{}');

    if (!Array.isArray(items) || items.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Panier vide.' }) };
    }

    const siteUrl = process.env.URL || 'https://ateliers-sonia.fr';

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${siteUrl}/merci.html?session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${siteUrl}/#galerie`);
    params.append('phone_number_collection[enabled]', 'true');

    // On ne demande une adresse complète que si ce n'est PAS une livraison
    // en point relais (dans ce cas, le point choisi est déjà connu via le widget).
    if (delivery !== 'Mondial Relay') {
      params.append('shipping_address_collection[allowed_countries][0]', 'FR');
    }

    items.forEach((item, i) => {
      const title = String(item.title || 'Tableau').slice(0, 120);
      const price = Math.round(Number(item.price) * 100);
      if (!price || price <= 0) throw new Error('Prix invalide pour : ' + title);

      params.append(`line_items[${i}][price_data][currency]`, 'eur');
      params.append(`line_items[${i}][price_data][product_data][name]`, title);
      params.append(`line_items[${i}][price_data][unit_amount]`, String(price));
      params.append(`line_items[${i}][quantity]`, '1');
    });

    if (delivery) {
      params.append('metadata[mode_livraison]', String(delivery).slice(0, 500));
    }
    if (deliveryDetail) {
      params.append('metadata[point_relais]', String(deliveryDetail).slice(0, 500));
    }

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await response.json();

    if (!response.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: session.error?.message || 'Erreur lors de la création du paiement.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
