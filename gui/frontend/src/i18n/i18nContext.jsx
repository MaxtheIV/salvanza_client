import { createContext, useContext, useState, useEffect } from 'react'
import translations from './translations'

const I18nContext = createContext()

export const LANGUAGES = ['de', 'en', 'fr']
const DEFAULT_LANGUAGE = 'de'

export function I18nProvider({ children }) {
  const [language, setLanguage] = useState(() => {
    // A stored choice always wins. Anything else (first run, or a value left
    // behind by an older build) falls back to the default rather than leaving
    // `translations[language]` undefined, which would render raw keys.
    const stored = localStorage.getItem('language')
    return LANGUAGES.includes(stored) ? stored : DEFAULT_LANGUAGE
  })

  useEffect(() => {
    localStorage.setItem('language', language)
    document.documentElement.lang = language
  }, [language])

  const t = (key) => {
    const keys = key.split('.')
    let value = translations[language] || translations[DEFAULT_LANGUAGE]

    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = value[k]
      } else {
        return key // Return key if translation not found
      }
    }

    return value || key
  }

  // Same lookup, with {placeholder} substitution, so callers stop chaining
  // .replace() by hand. Missing vars are left as-is rather than printing
  // "undefined" into a message the user reads.
  const tf = (key, vars = {}) =>
    Object.entries(vars).reduce(
      (out, [name, value]) => out.split(`{${name}}`).join(String(value)),
      t(key)
    )

  return (
    <I18nContext.Provider value={{ language, setLanguage, t, tf }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useTranslation() {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useTranslation must be used within I18nProvider')
  }
  return context
}
