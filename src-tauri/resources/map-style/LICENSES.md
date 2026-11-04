# Style de carte embarqué — licences

Ces fichiers sont ceux d'OpenFreeMap (https://openfreemap.org, dépôt https://github.com/hyperknot/openfreemap-styles, MIT, Copyright (c) 2023 Zsolt Ero),
récupérés par `scripts/fetch-map-style.mjs` et utilisés par la carte de Photoboggan quand aucune copie plus récente n'a été téléchargée
(Paramètres > Cartes).

| Fichiers | Origine | Licence |
|---|---|---|
| `styles/liberty.json` | Fork de `maputnik/osm-liberty` (lui-même issu d'OSM Bright, Mapbox Open Styles) | Code : BSD 3-Clause. Design : CC BY 4.0 |
| `styles/dark.json` | Fork de `openmaptiles/dark-matter-gl-style` (CartoDB Basemaps, Stamen et Paul Norman pour CartoDB Inc.) | Code : BSD 3-Clause. Design : CC BY 4.0 (les CartoDB Basemaps d'origine : CC BY 3.0) |
| `sprites/` | Icônes Maki (Mapbox) ; flèche issue de Wikipédia | Maki : CC0 1.0 Universal. Flèche : domaine public |
| `fonts/Noto Sans …` | Noto Sans, glyphes convertis en PBF (openmaptiles/fonts) | SIL Open Font License 1.1 |

Obligations :

- BSD 3-Clause : conserver l'avis de copyright, la liste des conditions et la clause de non-responsabilité des projets d'origine ; ne pas utiliser
  les noms de leurs auteurs pour promouvoir un produit dérivé sans autorisation.
- CC BY : créditer « OpenMapTiles.org » avec un lien. Le crédit « OpenFreeMap © OpenMapTiles Data from OpenStreetMap » est affiché par la carte
  (voir `MAP_ATTRIBUTION` dans `src/map-config.js`).
- SIL OFL 1.1 : joindre la licence quand les polices sont redistribuées (ce fichier) et ne pas les vendre seules.
- Les données des tuiles proviennent d'OpenStreetMap (ODbL, © les contributeurs d'OpenStreetMap).

Les textes complets des licences sont ceux des dépôts d'origine :
https://github.com/maputnik/osm-liberty/blob/gh-pages/LICENSE.md,
https://github.com/openmaptiles/dark-matter-gl-style/blob/master/LICENSE.md,
https://github.com/hyperknot/openfreemap-styles/blob/main/LICENSE.md,
https://openfontlicense.org.
