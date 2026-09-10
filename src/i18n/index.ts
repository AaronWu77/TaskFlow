import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';

let savedLang: string | null = null;
try {
  savedLang = typeof localStorage !== 'undefined' ? localStorage.getItem('taskflow_lang') : null;
} catch {
  // Storage may be unavailable in privacy-restricted browsers.
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: savedLang || 'zh',
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
});

function updateDocumentLanguage(language: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = language.startsWith('zh') ? 'zh-CN' : 'en';
}
updateDocumentLanguage(i18n.language);
i18n.on('languageChanged', updateDocumentLanguage);

export default i18n;
