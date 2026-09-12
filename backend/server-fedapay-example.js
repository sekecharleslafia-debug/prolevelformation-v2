require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();

app.use(cors({
  origin: [
    'https://alibabaformation.netlify.app'
  ]
}));

app.use(express.json());
app.use(express.static(__dirname));

const FEDAPAY_ENV = process.env.FEDAPAY_ENV === 'live' ? 'live' : 'sandbox';
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_BASE_URL = FEDAPAY_ENV === 'live'
  ? 'https://api.fedapay.com/v1'
  : 'https://sandbox-api.fedapay.com/v1';

if (!FEDAPAY_SECRET_KEY) {
  console.warn('⚠️  FEDAPAY_SECRET_KEY manquante — les paiements échoueront.');
}

/* =========================================================
   BASE DE DONNÉES (MongoDB Atlas)
   ========================================================= */
const MONGODB_URI = process.env.MONGODB_URI;
let db = null;

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('prolevelformation');
  console.log('Connecté à MongoDB Atlas.');
  return db;
}

async function readPlacesData() {
  const database = await connectDB();
  const places = database.collection('places');
  let doc = await places.findOne({ _id: 'places' });
  if (!doc) {
    doc = { _id: 'places', total: 20, occupees: 0, transactionsTraitees: [] };
    await places.insertOne(doc);
  }
  return doc;
}

async function writePlacesData(data) {
  const database = await connectDB();
  await database.collection('places').updateOne(
    { _id: 'places' },
    { $set: data },
    { upsert: true }
  );
}

async function marquerPlaceOccupee(transactionId) {
  const data = await readPlacesData();
  if (data.transactionsTraitees.includes(transactionId)) {
    return { data, premiereFois: false };
  }
  if (data.occupees < data.total) {
    data.occupees += 1;
  }
  data.transactionsTraitees.push(transactionId);
  await writePlacesData(data);
  return { data, premiereFois: true };
}

async function creerInscription(registrationId, candidat) {
  const database = await connectDB();
  await database.collection('registrations').insertOne({
    _id: registrationId,
    ...candidat
  });
}

async function lireInscription(registrationId) {
  const database = await connectDB();
  return database.collection('registrations').findOne({ _id: registrationId });
}

async function mettreAJourInscription(registrationId, updates) {
  const database = await connectDB();
  await database.collection('registrations').updateOne(
    { _id: registrationId },
    { $set: updates }
  );
}

async function trouverInscriptionParTransaction(transactionId) {
  const database = await connectDB();
  return database.collection('registrations').findOne({ transactionId });
}

/* =========================================================
   ENVOI D'EMAIL (Brevo via API HTTPS)
   ========================================================= */
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'ProLevelFormation';

if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
  console.warn('⚠️  BREVO_API_KEY / BREVO_SENDER_EMAIL manquants — les emails ne partiront pas.');
}

async function envoyerEmailAcces(candidat) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.warn(`Email NON envoyé à ${candidat.email} (Brevo non configuré).`);
    return;
  }
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: candidat.email, name: candidat.nom || '' }],
        subject: 'Ton paiement est confirmé — Accès à la formation Alibaba',
        htmlContent: `
          <p>Bonjour ${candidat.nom || ''},</p>
          <p>Ton paiement de 5 000 FCFA a bien été reçu et confirmé. Merci pour ton inscription !</p>
          <p><strong>Formation :</strong> Apprendre à commander sur Alibaba<br>
             <strong>Dates :</strong> Du 14 Septembre au 18 Septembre, chaque jour à 20h</p>
          <p>Connecte-toi ici le jour du début de la formation :<br>
             <a href="https://alibabaformation.netlify.app/acces.html">https://alibabaformation.netlify.app/acces.html</a></p>
          <p>Bonne formation !<br>L'équipe ProLevelFormation</p>
        `
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(JSON.stringify(errData));
    }

    console.log(`Email d'accès envoyé à ${candidat.email}`);
  } catch (err) {
    console.error(`Erreur envoi email à ${candidat.email}:`, err.message);
  }
}

/* =========================================================
   INSCRIPTION
   ========================================================= */
app.post('/api/register', async (req, res) => {
  try {
    const { nom, email, whatsapp, ville } = req.body || {};

    if (!nom || !email) {
      return res.status(400).json({ error: 'Nom et email sont obligatoires.' });
    }

    const registrationId = crypto.randomUUID();

    await creerInscription(registrationId, {
      nom, email, whatsapp, ville,
      transactionId: null,
      paye: false,
      emailEnvoye: false,
      creeLe: new Date().toISOString()
    });

    return res.json({ registrationId });
  } catch (err) {
    console.error('Erreur /api/register:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez plus tard.' });
  }
});

/* =========================================================
   CRÉATION DE LA TRANSACTION FEDAPAY
   ========================================================= */
app.post('/api/create-transaction', async (req, res) => {
  try {
    const { registrationId } = req.body || {};

    const candidat = registrationId ? await lireInscription(registrationId) : null;
    if (!candidat) {
      return res.status(400).json({ error: "Inscription introuvable. Merci de remplir le formulaire d'inscription d'abord." });
    }

    const places = await readPlacesData();
    if (places.occupees >= places.total) {
      return res.status(400).json({ error: 'COMPLET' });
    }

    const amount = 5000;
    const description = 'Formation - Commander sur Alibaba (ProLevelFormation)';

    const response = await fetch(`${FEDAPAY_BASE_URL}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ description, amount, currency: { iso: 'XOF' } })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erreur FedaPay:', data);
      return res.status(400).json({ error: "Impossible de créer la transaction." });
    }

    const transaction = data['v1/transaction'];

    await mettreAJourInscription(registrationId, {
      transactionId: String(transaction.id)
    });

    return res.json({ id: transaction.id });

  } catch (err) {
    console.error('Erreur serveur /api/create-transaction:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez plus tard.' });
  }
});

/* =========================================================
   WEBHOOK FEDAPAY
   ========================================================= */
app.post('/api/fedapay-webhook', async (req, res) => {
  const event = req.body;
  console.log('Webhook FedaPay reçu:', JSON.stringify(event));

  const eventName = event && event.name;
  const transaction = event && event.entity;

  if (eventName === 'transaction.approved' && transaction && transaction.id) {
    const transactionId = String(transaction.id);
    const { data: placesData, premiereFois } = await marquerPlaceOccupee(transactionId);
    console.log(`Place enregistrée. Places occupées : ${placesData.occupees}/${placesData.total}`);

    if (premiereFois) {
      const candidat = await trouverInscriptionParTransaction(transactionId);

      if (candidat) {
        await mettreAJourInscription(candidat._id, { paye: true });
        if (!candidat.emailEnvoye) {
          await envoyerEmailAcces(candidat);
          await mettreAJourInscription(candidat._id, { emailEnvoye: true });
        }
      } else {
        console.warn(`Aucun candidat trouvé pour la transaction ${transactionId} — email non envoyé.`);
      }
    }
  }

  res.sendStatus(200);
});

/* =========================================================
   NOMBRE DE PLACES
   ========================================================= */
app.get('/api/places', async (req, res) => {
  try {
    const data = await readPlacesData();
    res.json({ total: data.total, occupees: data.occupees });
  } catch (err) {
    console.error('Erreur /api/places:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT} (mode FedaPay: ${FEDAPAY_ENV})`);
  });
}).catch(err => {
  console.error('Impossible de se connecter à MongoDB:', err);
  process.exit(1);
});
