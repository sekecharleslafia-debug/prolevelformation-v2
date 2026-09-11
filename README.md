# ProLevelFormation — déploiement Netlify (frontend) + Render (backend)

## Structure du projet
assets/     → images (à la racine, à côté des pages HTML)
backend/    → server-fedapay-example.js + package.json → à déployer sur Render
*.html      → pages du site → à déployer sur Netlify

## Étape 1 — Déployer le backend sur Render
1. Sur Render : New + → Web Service → connecte ce repo GitHub.
2. Root Directory : backend
3. Build Command : npm install
4. Start Command : npm start
5. Dans l'onglet Environment, ajoute les variables (le contenu de ton .env) :
   - FEDAPAY_SECRET_KEY
   - FEDAPAY_ENV
   - GMAIL_USER
   - GMAIL_APP_PASSWORD
6. Déploie. Tu obtiens une URL du type https://prolevelformation-backend.onrender.com

## Étape 2 — Déployer le frontend sur Netlify
1. Sur Netlify : Add new site → Import an existing project → connecte ce même repo GitHub.
2. Base directory : laisse vide (racine du repo)
3. Publish directory : laisse vide (racine du repo)
4. Pas de build command nécessaire (fichiers HTML statiques).
5. Déploie. Tu obtiens une URL du type https://prolevelformation.netlify.app

## Étape 3 — Relier les deux (obligatoire, sinon rien ne marche)
Trois fichiers contiennent une constante API_BASE à remplacer par ta vraie URL Render :
- index.html
- inscription.html
- paiement.html

Dans backend/server-fedapay-example.js, remplace https://TON-SITE.netlify.app (2 endroits : le cors() et le lien dans l'email) par ta vraie URL Netlify.

Puis un nouveau commit sur GitHub : Netlify et Render se redéploient automatiquement.

## Étape 4 — Configurer le webhook FedaPay
Dans le dashboard FedaPay (mode sandbox pour tester) → Paramètres → Webhooks :
https://TON-BACKEND.onrender.com/api/fedapay-webhook

## Rappel important (plan gratuit Render)
- Le service backend s'endort après 15 min sans visite et met 30-60 sec à redémarrer au prochain appel — normal en test.
- Le stockage (places-data.json, registrations-data.json) n'est PAS garanti persistant sur le plan gratuit : il peut se réinitialiser à chaque redéploiement. Pour de vrais tests répétés, à surveiller ; avant la mise en ligne réelle, passer à une vraie base de données.
