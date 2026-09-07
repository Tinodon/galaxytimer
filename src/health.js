// Petit serveur HTTP, uniquement pour l'hebergeur.
//
// Render (offre gratuite) ne propose pas de "background worker" : un bot doit y
// tourner en "web service", et un web service qui n'ecoute aucun port est
// considere comme rate au deploiement. D'ou ce serveur, qui ne sert a rien
// d'autre.
//
// Second usage : Render endort un service gratuit apres 15 minutes sans
// requete. Un pinger externe (UptimeRobot, cron-job.org) appelle cette URL
// regulierement pour le garder eveille. Un bot endormi ne ping personne.
//
// IMPORTANT : ce serveur doit demarrer AVANT la connexion a Discord, pas apres.
// Render considere un deploiement reussi quand un port est ouvert ; si on
// attend d'etre connecte, le moindre souci de connexion laisse le deploiement
// bloque sur "Deploying..." sans le moindre message d'erreur.

import { createServer } from 'node:http';

export function startHealthServer({ port, status }) {
  if (!port) return null;

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify(status(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    // Toute autre route repond OK : le pinger n'a pas a connaitre le chemin.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GalaxyTimer is running.\n');
  });

  server.listen(port, () => console.log(`[health] listening on port ${port}`));
  server.on('error', (err) => console.error('[health] server error:', err.message));
  return server;
}
