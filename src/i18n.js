// Internationalisation : chaque texte d'interface est identifié par son libellé anglais (la clé),
// traduit via src/locales/<langue>.json. Pour ajouter un texte : ajouter la clé dans chaque fichier
// de langue, puis data-i18n="Clé" dans index.html (ou t('Clé') dans le JavaScript).
// Pour ajouter une langue : créer son fichier JSON et l'enregistrer dans LANGUAGES.
import en from './locales/en.json';
import fr from './locales/fr.json';

export const LANGUAGES = {
  fr: { label: 'Français', messages: fr },
  en: { label: 'English', messages: en },
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
export function t(key) {
  return LANGUAGES[currentLanguage].messages[key] ?? en[key] ?? key;
}

// Traduit les éléments marqués data-i18n (contenu), data-i18n-title (infobulle) et data-i18n-aria-label.
// Le texte déjà présent dans index.html sert de valeur par défaut (français) avant l'application.
export function applyTranslations(root = document) {
  document.documentElement.lang = currentLanguage;
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
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
