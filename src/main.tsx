import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Fuente de los nombres de las fichas. Se carga desde public/fonts (ver public/fonts/README.txt);
// si el archivo no está, las fichas usan la fuente de respaldo declarada en styles.css.
const fontBase = `${import.meta.env.BASE_URL}fonts/BurbankBigRegular-Black`
const burbank = new FontFace(
  'Burbank Big',
  `local('Burbank Big Regular Black'), local('BurbankBigRegular-Black'), url('${fontBase}.woff2') format('woff2'), url('${fontBase}.otf') format('opentype'), url('${fontBase}.ttf') format('truetype')`,
  { weight: '900' },
)
burbank
  .load()
  .then((font) => document.fonts.add(font))
  .catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
