# Dette — rencontres express

Un lieu sur la carte, une photo, un message. Les personnes intéressées
envoient une demande — tu choisis avec qui tu es « en dette ».

## Lancer le site en local

```bash
python -m http.server 5173
```

Puis ouvre **http://localhost:5173**

> ⚠️ Ouvre toujours le site via `http://localhost`, **jamais** en double-cliquant
> sur `index.html`. Les navigateurs bloquent la caméra sur les fichiers `file://`.

## Modifier le design

Le design est écrit avec **Tailwind CSS**. La source est `src/input.css`,
compilée vers `style.css`.

```bash
npm run build    # compile une fois
npm run watch    # recompile automatiquement à chaque modification
```

> ⚠️ Ne modifie **jamais** `style.css` directement : il est écrasé à chaque build.
> Modifie `src/input.css` (styles de composants) ou `tailwind.config.js` (couleurs,
> ombres, animations).

## Application installable (PWA)

Dette s'installe sur l'écran d'accueil comme une vraie application :
icône, plein écran sans barre de navigateur, démarrage hors ligne.

**Sur ordinateur** — dans Chrome, une icône d'installation apparaît à droite
de la barre d'adresse.

**Sur téléphone** — il faut d'abord mettre le site en ligne en **HTTPS**
(Vercel, Netlify…). Les navigateurs refusent d'installer une PWA servie en
`http://` sur le réseau local : seul `localhost` fait exception.

### Régénérer les icônes

```bash
python tools/make-icons.py
```

Les couleurs sont reprises de `tailwind.config.js`.

### Modifier le cache hors ligne

Après avoir changé la liste `COQUILLE` dans `sw.js`, incrémenter `VERSION`
(`dette-v2` → `dette-v3`) pour forcer la mise à jour chez les utilisateurs.

> Les échanges avec Supabase (authentification, offres, demandes, photos) ne
> sont **jamais** mis en cache : ces données doivent rester fraîches.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Structure des pages et classes Tailwind |
| `src/input.css` | **Source** du design (à modifier) |
| `style.css` | CSS compilé (généré, ne pas toucher) |
| `tailwind.config.js` | Couleurs, ombres, animations |
| `app.js` | Logique : carte, offres, demandes, caméra, Supabase |
| `supabase-config.js` | URL et clé publique du projet Supabase |
| `manifest.json` | Identité de l'application installable |
| `sw.js` | Service Worker : hors ligne et installation |
| `tools/make-icons.py` | Génère les icônes PNG |

## Base de données (Supabase)

| Table | Contenu |
|---|---|
| `profiles` | Les membres |
| `offers` | Les « dettes » posées sur la carte |
| `requests` | Les demandes envoyées sur une offre |

Les photos sont stockées dans le bucket `photos`.
Toutes les tables sont protégées par des règles RLS : chacun ne voit et ne
modifie que ce qui le concerne.

### Réglage requis

Les comptes sont créés automatiquement via la **connexion anonyme**.
Elle doit être activée une fois dans le tableau de bord Supabase :

**Authentication → Sign In / Providers → Anonymous sign-ins → activer → Save**
