import { useState, useEffect } from 'react'
import { SunIcon, MoonIcon } from '@phosphor-icons/react'
import { useTranslation } from '../i18n/i18nContext'

// No stored preference means the window follows the Windows light/dark
// setting via the `prefers-color-scheme` rules in index.css. Picking a mode
// here stamps `data-theme` on <html>, which overrides that media query in
// both directions.
function readStored() {
  const v = localStorage.getItem('theme')
  return v === 'light' || v === 'dark' ? v : null
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function ThemeToggle() {
  const { t } = useTranslation()
  const [theme, setTheme] = useState(readStored)

  useEffect(() => {
    const root = document.documentElement
    if (theme) {
      root.setAttribute('data-theme', theme)
      localStorage.setItem('theme', theme)
    } else {
      root.removeAttribute('data-theme')
      localStorage.removeItem('theme')
    }
  }, [theme])

  const isDark = theme ? theme === 'dark' : systemPrefersDark()

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? t('themeLight') : t('themeDark')}
      aria-label={isDark ? t('themeLight') : t('themeDark')}
    >
      {isDark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </button>
  )
}

export default ThemeToggle
