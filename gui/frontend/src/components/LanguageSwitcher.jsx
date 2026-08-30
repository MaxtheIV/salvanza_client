import { useTranslation, LANGUAGES } from '../i18n/i18nContext'

// Language codes rather than flag emoji: a flag names a country, not a
// language, and the switcher has to stay legible at 11px in the title bar.
const LABELS = { de: 'DE', en: 'EN', fr: 'FR' }
const NAMES = { de: 'Deutsch', en: 'English', fr: 'Français' }

function LanguageSwitcher() {
  const { language, setLanguage } = useTranslation()

  return (
    <div className="lang" role="group" aria-label="Language">
      {LANGUAGES.map(code => (
        <button
          key={code}
          type="button"
          onClick={() => setLanguage(code)}
          aria-pressed={language === code}
          title={NAMES[code]}
        >
          {LABELS[code]}
        </button>
      ))}
    </div>
  )
}

export default LanguageSwitcher
