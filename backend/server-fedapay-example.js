/**
 * server-fedapay-example.js
 * ---------------------------------------------------------
 * Petit serveur Node/Express d'exemple pour ProLevelFormation.
 *
 * Rôle :
 *  1. Servir les pages statiques (index.html, paiement.html,
 *     confirmation.html, acces.html, etc.)
 *  2. POST /api/register : enregistre un candidat (nom, email,
 *     whatsapp, ville) rempli sur inscription.html, AVANT paiement.
 *  3. POST /api/create-transaction : crée une transaction FedaPay
 *     côté serveur et la relie au candidat inscrit.
 *  4. POST /api/fedapay-webhook : reçoit la confirmation OFFICIELLE
 *     de FedaPay. C'est SEULEMENT à ce moment-là qu'une place est
 *     enregistrée comme occupée ET qu'un email est envoyé au
 *     candidat avec ses informations d'accès à la formation.
 *  5. GET /api/places : renvoie { total, occupees } — utilisé par
 *     index.html pour afficher les places en direct.
 *
 * ⚠️ POURQUOI TOUT SE JOUE AU WEBHOOK ?
 * Le webhook est envoyé directement par les serveurs de FedaPay,
 * après vérification réelle du paiement (code secret validé). C'est
 * la seule étape fiable pour dire "ce candidat a vraiment payé" —
 * donc c'est là, et seulement là, qu'on réserve une place et qu'on
 * envoie l'email d'accès. Le navigateur du client n'est jamais une
 * source fiable pour ça.
 *
 * Installation :
 *   npm init -y
 *   npm install express node-fetch dotenv cors nodemailer
 *   node server-fedapay-example.js
 *
 * Variables d'environnement (fichier .env à créer, JAMAIS commité) :
 *   FEDAPAY_SECRET_KEY=sk_sandbox_xxxxxxxxxxxxxxxx
 *   FEDAPAY_ENV=sandbox
 *   PORT=3000
 *
 *   # Envoi d'email via Gmail :
 *   GMAIL_USER=tonadresse@gmail.com
 *   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx   <- mot de passe d'application (PAS ton mot de passe Gmail normal)
 * ---------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // v2 (CommonJS)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();

// Autorise les requêtes venant de ton site Netlify.
// ⚠️ Remplace par ton vrai domaine Netlify une fois connu, pour ne
// pas laisser l'API ouverte à n'importe quel site.
app.use(cors({
  origin: [
    'https://TON-SITE.netlify.app'
    // Ajoute ici ton futur domaine personnalisé si tu en configures un.
  ]
}));

app.use(express.json());
// Le frontend (index.html, paiement.html, etc.) est maintenant hébergé
// séparément sur Netlify. Ce serveur n'expose donc plus que l'API.
// (On garde quand même express.static par sécurité/débogage, mais ce
// dossier ne contient plus de pages HTML.)
app.use(express.static(__dirname));

const FEDAPAY_ENV = process.env.FEDAPAY_ENV === 'live' ? 'live' : 'sandbox';
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_BASE_URL = FEDAPAY_ENV === 'live'
  ? 'https://api.fedapay.com/v1'
  : 'https://sandbox-api.fedapay.com/v1';

if (!FEDAPAY_SECRET_KEY) {
  console.warn('⚠️  FEDAPAY_SECRET_KEY manquante dans .env — les paiements échoueront.');
}

/* =========================================================
   ENVOI D'EMAIL (Gmail via SMTP + Nodemailer)
   ========================================================= */
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

let mailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
} else {
  console.warn('⚠️  GMAIL_USER / GMAIL_APP_PASSWORD manquants dans .env — les emails ne partiront pas.');
}

async function envoyerEmailAcces(candidat) {
  if (!mailTransporter) {
    console.warn(`Email NON envoyé à ${candidat.email} (Gmail non configuré).`);
    return;
  }
  try {
    await mailTransporter.sendMail({
      from: `"ProLevelFormation" <${GMAIL_USER}>`,
      to: candidat.email,
      subject: 'Ton paiement est confirmé — Accès à la formation Alibaba',
      html: `
        <p>Bonjour ${candidat.nom || ''},</p>
        <p>Ton paiement de 5 000 FCFA a bien été reçu et confirmé. Merci pour ton inscription !</p>
        <p><strong>Formation :</strong> Apprendre à commander sur Alibaba<br>
           <strong>Dates :</strong> Du 14 Septembre au 18 Septembre, chaque jour à 20h</p>
        <p>Connecte-toi ici le jour du début de la formation :<br>
           <a href="https://TON-SITE.netlify.app/acces.html">https://TON-SITE.netlify.app/acces.html</a></p>
        <p>Bonne formation !<br>L'équipe ProLevelFormation</p>
      `
    });
    console.log(`Email d'accès envoyé à ${candidat.email}`);
  } catch (err) {
    console.error(`Erreur envoi email à ${candidat.email}:`, err.message);
  }
}

/* =========================================================
   STOCKAGE DES CANDIDATS (fichier JSON pour l'exemple)
   En production, remplace ceci par une vraie base de données.
   ========================================================= */
const REGISTRATIONS_FILE = path.join(__dirname, 'registrations-data.json');

function readRegistrations() {
  if (!fs.existsSync(REGISTRATIONS_FILE)) {
    fs.writeFileSync(REGISTRATIONS_FILE, JSON.stringify({}, null, 2));
    return {};
  }
  return JSON.parse(fs.readFileSync(REGISTRATIONS_FILE, 'utf8'));
}

function writeRegistrations(data) {
  fs.writeFileSync(REGISTRATIONS_FILE, JSON.stringify(data, null, 2));
}

/* =========================================================
   STOCKAGE DES PLACES (fichier JSON pour l'exemple)
   ========================================================= */
const PLACES_FILE = path.join(__dirname, 'places-data.json');

function readPlacesData() {
  if (!fs.existsSync(PLACES_FILE)) {
    const initial = { total: 20, occupees: 0, transactionsTraitees: [] };
    fs.writeFileSync(PLACES_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
}

function writePlacesData(data) {
  fs.writeFileSync(PLACES_FILE, JSON.stringify(data, null, 2));
}

/**
 * Enregistre UNE place occupée pour la transaction donnée.
 * Retourne true si c'est la première fois qu'on traite cette
 * transaction (pour ne déclencher l'email qu'une seule fois).
 */
function marquerPlaceOccupee(transactionId) {
  const data = readPlacesData();
  if (data.transactionsTraitees.includes(transactionId)) {
    return { data, premiereFois: false };
  }
  if (data.occupees < data.total) {
    data.occupees += 1;
  }
  data.transactionsTraitees.push(transactionId);
  writePlacesData(data);
  return { data, premiereFois: true };
}

/* =========================================================
   INSCRIPTION — rempli sur inscription.html, AVANT paiement
   ========================================================= */
app.post('/api/register', (req, res) => {
  const { nom, email, whatsapp, ville } = req.body || {};

  if (!nom || !email) {
    return res.status(400).json({ error: 'Nom et email sont obligatoires.' });
  }

  const registrations = readRegistrations();
  const registrationId = crypto.randomUUID();

  registrations[registrationId] = {
    nom, email, whatsapp, ville,
    transactionId: null,
    paye: false,
    emailEnvoye: false,
    creeLe: new Date().toISOString()
  };
  writeRegistrations(registrations);

  return res.json({ registrationId });
});

/* =========================================================
   CRÉATION DE LA TRANSACTION FEDAPAY
   ========================================================= */
app.post('/api/create-transaction', async (req, res) => {
  try {
    const { registrationId } = req.body || {};

    const registrations = readRegistrations();
    const candidat = registrationId ? registrations[registrationId] : null;
    if (!candidat) {
      return res.status(400).json({ error: "Inscription introuvable. Merci de remplir le formulaire d'inscription d'abord." });
    }

    // On vérifie qu'il reste de la place AVANT de créer la transaction.
    const places = readPlacesData();
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
      body: JSON.stringify({
        description,
        amount,
        currency: { iso: 'XOF' }
        // callback_url: 'https://TON-BACKEND.onrender.com/api/fedapay-webhook'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erreur FedaPay:', data);
      return res.status(400).json({ error: "Impossible de créer la transaction." });
    }

    const transaction = data['v1/transaction'];

    // On relie cette transaction au candidat, pour savoir à qui
    // envoyer l'email une fois le webhook reçu.
    candidat.transactionId = String(transaction.id);
    registrations[registrationId] = candidat;
    writeRegistrations(registrations);

    return res.json({ id: transaction.id });

  } catch (err) {
    console.error('Erreur serveur /api/create-transaction:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez plus tard.' });
  }
});

/* =========================================================
   WEBHOOK FEDAPAY — source de vérité du paiement
   À configurer dans ton dashboard FedaPay > Paramètres > Webhooks
   avec l'URL : https://TON-BACKEND.onrender.com/api/fedapay-webhook
   ========================================================= */
app.post('/api/fedapay-webhook', async (req, res) => {
  const event = req.body;
  console.log('Webhook FedaPay reçu:', JSON.stringify(event));

  // ⚠️ À VÉRIFIER : confirme la forme exacte du payload dans les logs
  // ci-dessus (elle peut varier selon la version de l'API FedaPay).
  const eventName = event && event.name;
  const transaction = event && event.entity;

  if (eventName === 'transaction.approved' && transaction && transaction.id) {
    const transactionId = String(transaction.id);
    const { data: placesData, premiereFois } = marquerPlaceOccupee(transactionId);
    console.log(`Place enregistrée. Places occupées : ${placesData.occupees}/${placesData.total}`);

    if (premiereFois) {
      // Retrouve le candidat relié à cette transaction et lui envoie l'email d'accès.
      const registrations = readRegistrations();
      const registrationId = Object.keys(registrations).find(
        id => registrations[id].transactionId === transactionId
      );

      if (registrationId) {
        const candidat = registrations[registrationId];
        candidat.paye = true;
        if (!candidat.emailEnvoye) {
          await envoyerEmailAcces(candidat);
          candidat.emailEnvoye = true;
        }
        registrations[registrationId] = candidat;
        writeRegistrations(registrations);
      } else {
        console.warn(`Aucun candidat trouvé pour la transaction ${transactionId} — email non envoyé.`);
      }
    }
  }

  res.sendStatus(200);
});

/* =========================================================
   NOMBRE DE PLACES — lu par index.html
   ========================================================= */
app.get('/api/places', (req, res) => {
  const data = readPlacesData();
  res.json({ total: data.total, occupees: data.occupees });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT} (mode FedaPay: ${FEDAPAY_ENV})`);
  console.log(`Ouvre http://localhost:${PORT}/paiement.html pour tester.`);
});
