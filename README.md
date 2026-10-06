# Overwatch — ¿Quién es Quién? (2 vs 2)

Web multijugador diseñada para reproducir el juego de **Quién es Quién** con héroes de Overwatch.

## Qué hace esta versión

- El build detecta todos los `.png` de `public/characters/`.
- Al crear una sala el navegador selecciona **24 héroes aleatorios** y esa lista queda guardada en la sala.
- Los dos equipos ven exactamente los mismos 24 héroes.
- Cada equipo tiene su propio tablero de fichas.
- Los dos jugadores de un mismo equipo comparten exactamente el mismo estado de fichas.
- El otro equipo tiene un tablero distinto e independiente.
- El chat central es privado por equipo: Azul solo ve Azul y Rojo solo ve Rojo.
- Hay 4 puestos: 2 jugadores por equipo.
- Los cuatro cursores se muestran en grande y se sincronizan en tiempo real.
- `cursor.png` / `cursoragarrando.png` y `cursor2.png` / `cursoragarrando2.png` se usan según el puesto del jugador.
- Arriba quedan reservados los cuatro huecos cuadrados para futuras cámaras y el chat en el centro.

## 1. Añadir personajes

Mete todos tus PNG en:

```text
public/characters/
```

El nombre del archivo se convierte en el nombre mostrado.

Ejemplo:

```text
public/characters/ANA.png
public/characters/ASHE.png
public/characters/D.VA.png
```

Al ejecutar `npm run build` o `npm run dev`, `scripts/generate-manifest.mjs` genera automáticamente:

```text
public/characters.json
```

No tienes que escribir a mano una lista de héroes.

Necesitas **mínimo 24 PNG**.

## 2. Añadir los cursores

Mete estos cuatro archivos en:

```text
public/cursors/
```

```text
cursor.png
cursoragarrando.png
cursor2.png
cursoragarrando2.png
```

La aplicación tiene un cursor de fallback para que la web no se quede inutilizable si alguno no está todavía.

## 3. Crear el backend de la partida

Esta versión utiliza Supabase para:

- autenticación anónima de cada jugador;
- guardar las salas y sus 24 héroes;
- guardar el estado del tablero de cada equipo;
- guardar el chat de cada equipo;
- sincronizar lobby, tablero y chat en tiempo real;
- transmitir los cuatro cursores mediante Realtime Broadcast.

En Supabase:

1. Crea un proyecto nuevo.
2. Abre **SQL Editor**.
3. Ejecuta completo el archivo:

```text
supabase/schema.sql
```

4. Ve a **Authentication → Providers** y activa **Anonymous Sign-Ins**.
5. Copia la URL del proyecto y la **Publishable Key**.

## 4. Variables locales

Copia:

```text
.env.example
```

a:

```text
.env
```

Y rellena:

```text
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxx
```

No pongas una `service_role` o secret key en el frontend.

## 5. Probar en local

Con Node.js instalado:

```bash
npm install
npm run dev
```

Abre la URL que te muestre Vite.

Para probar el 2 vs 2 de verdad, abre la misma URL en **4 ventanas/perfiles de navegador distintos** y únete a cuatro puestos diferentes.

## 6. Cómo se juega

### Jugador 1

Pulsa **Crear partida**.

Se genera, por ejemplo:

```text
Q7M4K
```

El creador entra automáticamente en Equipo Azul / Jugador 1.

### Jugadores 2–4

Comparten ese código y cada uno elige:

- Equipo Azul / Jugador 2
- Equipo Rojo / Jugador 3
- Equipo Rojo / Jugador 4

Cuando entren, la sala conoce ya los cuatro jugadores.

### Fichas

Al hacer clic sobre una carta se llama a la función SQL `toggle_card()`.

La fila del tablero pertenece al equipo, no al jugador:

```text
Sala X + Equipo Azul → tablero Azul
Sala X + Equipo Rojo → tablero Rojo
```

Por eso los dos jugadores de Azul ven los mismos descartes y los dos jugadores de Rojo ven los suyos.

Además, la operación de bajar/subir una ficha se bloquea en la base de datos con un `FOR UPDATE`, así que dos clics simultáneos del mismo equipo no deberían pisarse.

### Chat

Los mensajes llevan `team = 1` o `team = 2`.

Las políticas RLS de Supabase solo permiten leer mensajes del propio equipo. La interfaz tampoco muestra el chat rival.

### Cursores

Cada navegador envía la posición normalizada de su cursor mediante Realtime Broadcast.

La posición se transmite aproximadamente cada 35 ms como máximo para no mandar una petición por cada pixel de movimiento.

Al pulsar el botón del ratón el cursor cambia a `cursoragarrando*.png` y al soltar vuelve al cursor normal.

## 7. Publicarlo gratis

Una configuración sencilla es:

**Frontend:** GitHub Pages Free

**Backend multiplayer:** Supabase Free

Sube este proyecto a GitHub y conecta el repositorio a GitHub Pages.

Configura en GitHub Pages estas variables de entorno:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Comando de build:

```text
npm run build
```

Carpeta de publicación:

```text
dist
```

Cada vez que cambies los personajes en `public/characters/`, haz un nuevo deploy para que el manifest vuelva a generarse.

## 8. Qué parte falta para una versión de producción

La versión entregada ya cubre el núcleo multijugador que pediste. Las siguientes mejoras serían independientes:

- integrar las cuatro cámaras reales (WebRTC, OBS/VDO.Ninja o la solución que uses);
- permitir marcar el personaje secreto de cada equipo;
- añadir botón para empezar/cerrar la partida;
- expulsar jugadores o proteger la sala con una contraseña adicional;
- borrar salas antiguas automáticamente para no acumular datos;
- sonido/animaciones de fichas y efectos de selección;
- adaptar la interfaz a una resolución concreta si sabes exactamente cómo será el layout final de las cámaras.
