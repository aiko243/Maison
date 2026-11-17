# Maison

Une petite application pour partager les tâches de la maison à deux : qui fait quoi, quand, et ce qui est fait.
Elle s'installe sur l'écran d'accueil de l'iPhone et d'Android, et se synchronise en temps réel entre vos deux téléphones.

**Fonctionnalités**
- **Accueil** : ta journée (tes tâches du jour et celles en retard), le récap de la semaine pour chacun, les rappels à cocher et les notes partagées.
- **Semaine** et **Mois** : le calendrier des tâches de ménage, une couleur par personne.
- **Actions** : une liste d'icônes de ménage (vaisselle, évier, four, micro-ondes…) modifiable à deux : ajouter une action avec son emoji, choisir son rang, réordonner, retirer.
- **Commentaires** sur chaque tâche.
- Mode clair/sombre, changement de mot de passe, indicateur de sauvegarde, copies automatiques et export/import.

À venir : tâches récurrentes.

---

## 1. Mise en place (une seule fois)

### Firebase
1. Projet créé sur [console.firebase.google.com](https://console.firebase.google.com) (forfait gratuit Spark, sans carte bancaire).
2. **Authentication** → méthode **E-mail/Mot de passe** activée → les deux comptes ajoutés à la main dans l'onglet **Utilisateurs**.
3. **Firestore Database** créée en **mode production**, emplacement `europe-west9 (Paris)`.
4. **Règles** : ouvrir *Firestore Database → Règles*, coller le contenu du fichier [`firestore.rules`](firestore.rules), remplacer `UID_PERSONNE_1` et `UID_PERSONNE_2` par vos deux UID (*Authentication → Utilisateurs*, colonne « UID utilisateur »), puis **Publier**.
   ⚠️ Les vrais UID restent uniquement dans la console Firebase, jamais dans ce dépôt.
5. **Configuration** : *Paramètres du projet → Vos applications → Web (`</>`)* → copier les valeurs de `firebaseConfig` dans [`firebase-config.js`](firebase-config.js).

### GitHub Pages
*Settings → Pages → Source : Deploy from a branch → Branch : `main` / `(root)` → Save.*
Au bout d'une minute, l'app est en ligne sur `https://aiko243.github.io/maison/`.

### Sur vos téléphones
- **iPhone** : ouvrir le lien dans **Safari** → bouton Partager → **Sur l'écran d'accueil**.
- **Android** : ouvrir le lien dans **Chrome** → menu ⋮ → **Installer l'application**.

Au premier lancement, chacun se connecte avec son e-mail et son mot de passe, puis choisit son prénom et sa couleur. Les prénoms sont enregistrés dans votre base, pas dans le code.

---

## 2. La sécurité, en clair

| Mesure | Ce que ça veut dire pour vous |
|---|---|
| Pas d'écran d'inscription | Les deux comptes ont été créés à la main. Personne ne peut s'inscrire depuis l'app. |
| Liste blanche dans les règles Firestore | Seuls vos deux comptes peuvent lire ou écrire. Un inconnu, même connecté, ne voit rien. C'est le vrai verrou. |
| Contrôle de chaque donnée | La base refuse tout ce qui n'a pas la bonne forme (titre trop long, date invalide, personne inconnue…). |
| Aucun effacement définitif | La base interdit de supprimer une tâche : elle est seulement masquée, donc récupérable. |
| Copies verrouillées | Une copie de sauvegarde ne peut jamais être modifiée, et ne peut être supprimée qu'après 35 jours. |
| Pas de secret dans le code | La « clé » de `firebase-config.js` n'est qu'un identifiant de projet, prévu pour être public. |
| HTTPS | GitHub Pages chiffre toutes les connexions. |
| Politique de contenu (CSP) | Le navigateur refuse d'exécuter du code venant d'un autre site que le vôtre et Firebase. |
| Textes affichés « tels quels » | Ce que vous tapez n'est jamais interprété comme du code (protection contre l'injection). |
| Mot de passe oublié | Lien de réinitialisation envoyé par e-mail, sans révéler si le compte existe. |

**Conseils** : mots de passe longs (12 caractères minimum) et différents de vos autres comptes. Dans la console Firebase, *Authentication → Paramètres → Actions des utilisateurs* : décochez « Activer la création (inscription) » si l'option est proposée.

---

## 3. Les sauvegardes

| Niveau | Comment ça marche |
|---|---|
| **En ligne, en continu** | Chaque modification part sur Firebase en quelques secondes. Hors ligne, elle est gardée sur le téléphone et envoyée toute seule au retour du réseau. |
| **Copie automatique par jour** | À la première ouverture de la journée, l'app enregistre une copie complète (tâches, notes, rappels, actions). Les 35 derniers jours sont conservés. (Les sauvegardes intégrées de Firebase sont payantes : c'est l'alternative gratuite.) |
| **Fichier sur l'appareil** | *⋯ → Télécharger une copie* : un fichier `.json` à garder dans Fichiers, Drive, etc. Indispensable en cas de problème avec le compte Firebase lui-même. Conseil : une fois par mois. |
| **Restaurer** | *⋯ → Copies en ligne → Restaurer*, ou *Importer un fichier*. Avant chaque restauration, une copie de l'état actuel est faite automatiquement : on peut toujours revenir en arrière. |

**Indicateur en bas de l'écran** (touchez-le pour le détail) :
- 🟢 *Sauvegardé à 19:24* — tout est en ligne
- 🟠 *Enregistrement…* / *Hors ligne · en attente d'envoi* — gardé sur le téléphone, partira tout seul
- ⚪ *Hors ligne* — rien en attente
- 🔴 *Échec de l'enregistrement* — une modification a été refusée

**Notes partagées** : elles sont protégées comme le reste (visibles par vous deux uniquement), mais évitez d'y mettre des codes bancaires ou des mots de passe importants.

**Mises à jour de l'app** : le code est sur GitHub, les données sur Firebase. Mettre à jour l'un ne touche jamais l'autre. Les nouvelles versions ajouteront des informations aux tâches sans jamais en effacer.

---

## 4. Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Les écrans |
| `style.css` | L'apparence (clair et sombre) |
| `app.js` | Le fonctionnement |
| `firebase-config.js` | L'adresse de votre projet Firebase |
| `firestore.rules` | Modèle des règles de sécurité (à coller dans la console, à refaire quand ce fichier change) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil et ouverture hors ligne |
