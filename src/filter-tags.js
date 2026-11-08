// Étiquettes des filtres affichées sur les lignes repliées du bloc Filtres et dans ses badges : un texte coloré par type de filtre et,
// quand on sait comment le retirer, une petite croix qui l'efface d'un clic sans déplier le groupe.
import { t } from './i18n.js';
import { openContextMenuAt } from './photo-actions.js';

/**
 * Crée une étiquette de filtre.
 * - kind : type de filtre (classe `tag-<kind>`, voir la couleur dans styles.css) ;
 * - text : texte affiché ; title : infobulle (par défaut, le texte lui-même) ;
 * - onRemove : si fournie, ajoute la croix de retrait ; elle reçoit l'événement de clic (qui ne se propage pas : le groupe ne se déplie pas).
 * Le texte seul reste lisible dans `dataset.label` : l'étiquette « … » de la ligne repliée s'en sert pour lister les étiquettes masquées.
 */
export function createFilterTag({ kind, text, title = '', onRemove = null }) {
  const tag = document.createElement('span');
  tag.className = `filter-tag tag-${kind}`;
  tag.dataset.label = text;
  tag.title = title || text; // le texte, tronqué quand la barre latérale est étroite, reste lisible en infobulle
  if (!onRemove) {
    tag.textContent = text;
    return tag;
  }
  const label = document.createElement('span');
  label.className = 'filter-tag-text';
  label.textContent = text;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'filter-tag-clear';
  remove.textContent = '×';
  const hint = t('Remove filter {keyword}', { keyword: text });
  remove.title = hint;
  remove.setAttribute('aria-label', hint);
  remove.addEventListener('click', event => {
    event.stopPropagation();
    onRemove(event);
  });
  tag.classList.add('has-clear');
  tag.append(label, remove);
  return tag;
}

/**
 * Include / exclude state of a filter chip (keywords, people, gear, format, filename): an excluded chip gets the `excluded` class (violet,
 * see styles.css) and a right-click opens a small menu that switches it. `label`: chip text, shown as the menu header;
 * `onToggle()`: switches the entry to the other state, re-renders and filters again.
 */
export function addIncludeExcludeMenu(node, { label, excluded, onToggle }) {
  node.classList.toggle('excluded', excluded);
  node.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenuAt(event, [
      { header: label },
      { label: t(excluded ? 'Include' : 'Exclude'), onSelect: onToggle },
    ]);
  });
}
