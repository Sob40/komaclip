# Contrato Visual Y Funcional Del MVP

Este documento fija la referencia de producto para migrar el MVP original
`panel2reels-mvp` a KomaClip.

La regla principal es sencilla: el resultado para el usuario debe sentirse como
el MVP actual, pero la implementacion interna debe ser de producto real.

## Decision De Producto

KomaClip no debe reinventar el flujo ni el lenguaje visual del MVP original.

Se conserva:

1. El flujo guiado para convertir material de comic/webtoon en un clip social.
2. La sensacion de estudio visual oscuro con paneles compactos y telefono fijo.
3. La edicion por escenas/shots con preview Pixi inmediato.
4. La logica de direccion: objetivo, estilo, propuesta, ajuste y export.
5. El catalogo visual curado como fuente de decisiones creativas.

Se cambia:

1. La arquitectura interna.
2. La seguridad.
3. La gestion de usuarios, proyectos, permisos y pagos.
4. El almacenamiento de archivos.
5. El render/export como proceso controlado por backend.
6. La estructura del codigo frontend.

## Referencia Original

Fuente local:

```text
/Users/asargues/panel2reels-mvp
```

Archivos principales revisados:

1. `index.html`
2. `styles.css`
3. `app.js`
4. `data/visual-catalog-v2.json`
5. `data/effects-engine.json`
6. `data/music-tracks.json`
7. `schema/montage.schema.json`
8. `schema/render-payload.schema.json`
9. `renderers/pixi/pixi-preview-renderer.js`

La captura funcional del MVP muestra una interfaz oscura tipo estudio creativo:

1. Fondo oscuro con textura/patron sutil.
2. Navbar sticky con marca, tabs y CTA.
3. Workspace a la izquierda.
4. Preview de telefono a la derecha.
5. Botones con gradiente fucsia/naranja/violeta.
6. Estados activos en mint/amarillo.
7. Paneles glass con borde fino y radio 8px.

## Flujo Que Hay Que Preservar

### 1. Material

El primer paso visible para usuario es subir material.

Debe conservar:

1. Dropzone para paginas, vinetas, GIFs o videos.
2. Boton principal para elegir archivos.
3. Revision de material despues de subir.
4. Orden de escenas editable.
5. Opcion de excluir escenas.
6. Texto opcional por escena.
7. Confirmacion explicita de material antes de avanzar.

En KomaClip:

1. Los archivos seran `ProjectAsset`.
2. Las escenas/paneles seran `Panel`.
3. El orden debe guardarse en base de datos.
4. El frontend no debe asumir que un asset pertenece al usuario; Rails lo valida.

### 2. Direccion

El MVP mantiene una decision creativa guiada.

Debe conservar:

1. Objetivo:
   - conseguir lectores
   - anunciar capitulo
   - personaje/comunidad
   - vender/campana
2. Estilo:
   - trailer tenso
   - impacto rapido
   - capitulo limpio
   - scroll webtoon
   - foco personaje
   - promo venta
   - making of
3. Resumen de direccion con objetivo y estilo.
4. El comportamiento de seleccion por tarjetas.
5. El avance progresivo: objetivo -> estilo -> propuesta.

En KomaClip:

1. La direccion debe guardarse como campos del proyecto o como draft de clip.
2. Las tarjetas deben mapear a ids estables, no a textos sueltos.
3. El contenido visible debe estar traducido en EN/ES.

### 3. Propuesta

El MVP genera una propuesta local y opcionalmente la mejora con IA.

Debe conservar:

1. Boton "Crear propuesta".
2. Brief opcional.
3. Campo "No revelar" para spoilers.
4. Ajustes de genero, tiempo por vineta e intensidad.
5. Resultado automatico: un clip con shots, textos, musica, ritmo, efectos y
   transiciones.

En KomaClip:

1. La propuesta local puede nacer de reglas backend/frontend.
2. La IA real, si se usa, debe devolver JSON validado.
3. Nunca se guarda una respuesta IA sin normalizar.
4. El contrato final lo reconstruye el servidor.

### 4. Editor De Clip

Esta es la parte mas importante del MVP.

Debe conservar:

1. Panel de ajuste rapido global.
2. Lectura/ritmo.
3. Intensidad.
4. Musica y volumen.
5. Controles avanzados:
   - patron visual
   - texto visual
   - animacion de texto
   - efecto visual
   - movimiento
   - transicion
6. Lista de shots con:
   - miniatura
   - fase: intro, desarrollo, climax, cierre
   - texto en pantalla editable
   - animacion
   - resumen Pixi de movimiento, efecto y transicion
7. Warnings de layout cuando algo puede tapar la UI social.
8. Chips de metadata del clip.

En KomaClip:

1. El editor debe modificar `clip.scene_contract` mediante endpoints seguros.
2. El usuario no debe enviar un JSON libre que Rails acepte sin validar.
3. El backend debe reconstruir o filtrar los cambios permitidos.
4. Cada cambio importante debe poder persistirse.
5. El preview Pixi debe responder a los cambios.

### 5. Preview De Telefono

El telefono fijo es parte central del MVP y debe mantenerse.

Debe conservar:

1. Frame 9:16 a la derecha en desktop.
2. Canvas/Pixi dentro del telefono.
3. Selector de salida:
   - Reels
   - TikTok
   - Shorts
4. Botones:
   - reproducir
   - musica
   - exportar
   - preview visual/MP4 cuando aplique
5. Nota de contexto bajo los botones.
6. Preview inmediato al generar y editar.

En KomaClip:

1. Pixi se carga solo en pantallas de preview/editor.
2. Las URLs de assets son firmadas y runtime-only.
3. El contrato persistido no contiene URLs publicas ni temporales.
4. El render final se hara desde un job/backend, no desde confianza ciega en el
   navegador.

### 6. Resultados

Debe conservar:

1. Tarjetas de version/clip.
2. Titulo, intencion, hook/copy y tags.
3. Seleccion de clip.
4. Descarga/export desde la version elegida.

En KomaClip:

1. Un render es `ClipRender`.
2. El estado de render debe ser visible.
3. El usuario solo puede descargar renders propios.
4. El acceso a export puede depender de plan/pago.

### 7. Lab Visual

El Lab del MVP es valioso como herramienta interna, no necesariamente como
pantalla de usuario final en el MVP publico.

Debe conservar para admin/producto:

1. Archivo visual por tabs:
   - efectos
   - camara
   - textos
   - transiciones
2. Filtros por estilo, estado y busqueda.
3. Previews Pixi de presets.
4. Estados de calidad:
   - final
   - pulir
   - legacy
5. Votacion/curacion del catalogo.

En KomaClip:

1. El Lab debe ser admin-only al principio.
2. El usuario normal solo ve presets productivos y seguros.
3. El catalogo debe estar versionado.

## Sistema Visual A Preservar

### Layout

Desktop:

1. Shell de dos columnas.
2. Workspace principal a la izquierda.
3. Preview pane a la derecha.
4. Navbar sticky arriba.
5. Preview sticky bajo navbar.

Mobile:

1. Flujo vertical.
2. Preview debe seguir siendo accesible sin romper el ancho.
3. Controles deben envolver sin overflow horizontal.

### Estetica

1. Tema oscuro.
2. Fondo con patron sutil.
3. Paneles translucid/glass.
4. Bordes finos `rgba(255,255,255,0.12)`.
5. Radio general de 8px.
6. Sombras profundas.
7. CTA con gradiente fucsia/naranja/violeta.
8. Estados activos en mint/amarillo.
9. Tipografia principal: Inter.
10. Tipografia display/marca: Space Grotesk.
11. Fuentes comic para video/texto: Bangers, Bungee, Comic Neue, Luckiest Guy.

### Colores Base

Referencia del skin final del MVP:

```text
bg: #07070d
ink: #f8f6ff
muted: #aaa6bd
line: rgba(255, 255, 255, 0.12)
panel: rgba(17, 18, 30, 0.86)
accent: #ff3d7f
accent-dark: #ff7bd3
mint: #55f0c8
blue: #7aa7ff
yellow: #ffd95a
```

## Contratos De Datos Que Deben Sobrevivir

El MVP trabaja con esta cadena conceptual:

```text
assets ordenados + direccion + catalogos cerrados
-> montagePlan
-> clip/shots
-> Pixi scene contract
-> preview/export
```

KomaClip debe conservar esa cadena con nombres mas productivos:

```text
ProjectAsset + Panel + ClipDirection
-> Clip.scene_contract
-> Pixi preview
-> ClipRender job
```

Campos clave por shot:

1. panel/asset reference.
2. start/end/duration.
3. phase: hook/body/climax/close.
4. overlay text.
5. text style.
6. text animation.
7. camera motion.
8. active effect.
9. transition.
10. crop/focus.

## Lo Que No Debe Copiarse Tal Cual

No copiar directamente:

1. `app.js` como monolito.
2. El servidor Python como backend de produccion.
3. API key temporal en navegador.
4. Render endpoints abiertos.
5. Vendor local de Pixi o ffmpeg.
6. Outputs de `renders/` o `tmp/`.
7. Remotion como core del producto.

Si se reutiliza logica del MVP, debe entrar como:

1. Service object.
2. Modulo Pixi pequeno.
3. Catalogo versionado.
4. Test de contrato.
5. Componente UI aislado.

## Traduccion EN/ES

El MVP original esta en espanol. KomaClip tendra:

1. Ingles por defecto.
2. Espanol seleccionable.
3. Misma estructura visual en ambos idiomas.

Regla:

1. El layout no puede depender de que el texto en espanol sea mas corto.
2. Las tarjetas y botones deben soportar labels mas largos.
3. Los ids de estilos, objetivos y presets no se traducen; solo se traducen los
   nombres visibles.

## Prioridad De Implementacion

Para mantener el resultado igual, el siguiente orden es:

1. Crear shell de app/editor con el estilo del MVP original.
2. Mover la pantalla de proyecto hacia flujo guiado:
   - material
   - direccion
   - propuesta
   - editor
   - resultados
3. Convertir el preview actual en telefono sticky.
4. Implementar direccion objetivo/estilo como datos persistidos.
5. Generar propuesta local desde paneles y catalogo.
6. Editar shots y guardar contrato.
7. Conectar catalogo visual real a Pixi.
8. Crear renders como jobs.
9. Dejar Lab como admin-only.

## Criterio De Aceptacion

Antes de dar por bueno un bloque de editor, debe cumplir:

1. Se parece visualmente al MVP original.
2. Mantiene el flujo progresivo.
3. No introduce una experiencia tipo dashboard generico.
4. Funciona en ingles y espanol.
5. No rompe el preview Pixi.
6. No filtra URLs privadas en contratos persistidos.
7. No acepta modificaciones de otro usuario.
8. Pasa CI.
9. Tiene prueba de navegador cuando cambia UI renderizada.

## Regla Final

KomaClip puede mejorar el MVP por dentro, pero no debe perder lo que hace que el
MVP guste:

1. Flujo guiado.
2. Sensacion de herramienta creativa.
3. Preview de telefono siempre presente.
4. Controles visuales concretos.
5. Resultado social listo para Reels/TikTok/Shorts.
