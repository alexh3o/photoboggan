// Internationalisation : chaque texte d'interface est identifié par son libellé anglais (la clé),
// traduit via src/locales/<langue>.json. Pour ajouter un texte : ajouter la clé dans chaque fichier
// de langue, puis data-i18n="Clé" dans index.html (ou t('Clé') dans le JavaScript).
// Pour ajouter une langue : créer son fichier JSON et l'enregistrer dans LANGUAGES.
import en from './locales/en.json';
import fr from './locales/fr.json';

// `colon` : séparateur entre un libellé et sa valeur (espace insécable avant les deux-points en français).
export const LANGUAGES = {
  fr: { label: 'Français', messages: fr, colon: '\u00a0:' },
  en: { label: 'English', messages: en, colon: ':' },
};
export const DEFAULT_LANGUAGE = 'fr';
const STORAGE_KEY = 'appLanguage';

const isSupported = language => Object.prototype.hasOwnProperty.call(LANGUAGES, language);
const storedLanguage = localStorage.getItem(STORAGE_KEY);
let currentLanguage = isSupported(storedLanguage) ? storedLanguage : DEFAULT_LANGUAGE;
const listeners = new Set();

export function getLanguage() {
  return currentLanguage;
}

// Texte traduit ; à défaut, l'anglais puis la clé elle-même, pour qu'un texte manquant reste lisible.
// `params` remplace les {nom} du texte : t('Write failed: {error}', { error }).
export function t(key, params) {
  const text = LANGUAGES[currentLanguage].messages[key] ?? en[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
}

const hasMessage = key => key in LANGUAGES[currentLanguage].messages || key in en;

// Texte avec pluriel : la clé porte la forme singulière, la clé suffixée de "|other" la forme plurielle
// (choix selon les règles de la langue courante : en français 0 et 1 sont au singulier). {count} est ajouté aux paramètres.
export function tp(key, count, params = {}) {
  const pluralKey = `${key}|other`;
  const useOther = new Intl.PluralRules(currentLanguage).select(count) !== 'one' && hasMessage(pluralKey);
  return t(useOther ? pluralKey : key, { count, ...params });
}

// Libellé suivi du séparateur de la langue : labelWithColon('Current rating') -> "Note actuelle :" / "Current rating:".
export function labelWithColon(key) {
  return `${t(key)}${LANGUAGES[currentLanguage].colon}`;
}

// Remplace le texte d'un élément sans supprimer ses éléments enfants (ex. <label>Texte <select></select></label>) :
// sans enfant on remplace tout, sinon seulement le premier texte non vide.
function setElementText(element, text) {
  if (!element.firstElementChild) {
    element.textContent = text;
    return;
  }
  const textNode = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
  if (textNode) textNode.nodeValue = text;
  else element.prepend(text);
}

// Attributs traduisibles : data-i18n-<attribut>="Clé" traduit l'attribut correspondant.
const TRANSLATED_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'];

// Traduit les éléments marqués data-i18n (contenu) et data-i18n-title / -aria-label / -placeholder / -alt.
// Le texte déjà présent dans index.html sert de valeur par défaut (français) avant l'application.
export function applyTranslations(root = document) {
  document.documentElement.lang = currentLanguage;
  for (const element of root.querySelectorAll('[data-i18n]')) setElementText(element, t(element.dataset.i18n));
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    const marker = `data-i18n-${attribute}`;
    for (const element of root.querySelectorAll(`[${marker}]`)) element.setAttribute(attribute, t(element.getAttribute(marker)));
  }
}

// Pour re-générer les textes construits en JavaScript quand la langue change.
export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLanguage(language) {
  if (!isSupported(language) || language === currentLanguage) return;
  currentLanguage = language;
  localStorage.setItem(STORAGE_KEY, language);
  applyTranslations();
  listeners.forEach(listener => listener(language));
}
