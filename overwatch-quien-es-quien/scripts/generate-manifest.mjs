import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const folder = join(process.cwd(), 'public', 'characters')
const output = join(process.cwd(), 'public', 'characters.json')

const entries = await readdir(folder, { withFileTypes: true })
const characters = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
  .map((entry) => entry.name.slice(0, -4))
  .sort((a, b) => a.localeCompare(b, 'es'))

await writeFile(output, JSON.stringify({ characters }, null, 2), 'utf8')
console.log(`characters.json: ${characters.length} PNG encontrados.`)
if (characters.length < 24) {
  console.warn('Aviso: hacen falta al menos 24 personajes para crear una partida.')
}
