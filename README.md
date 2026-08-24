# PDF Viewer & Editor

Editor visual de PDF gratuito para Visual Studio Code, construido en JavaScript con MuPDF.js y Fabric.js.

La versión `0.0.7` se concentra en una tarea: **hacer que el marco azul sea el área real del objeto editable, con geometría alineada al PDF**. Abre el PDF como una pestaña editable de VS Code y participa en el ciclo normal de Guardar, Guardar como, Deshacer, Rehacer, recuperación y copias de seguridad.

> Conserva una copia del documento original cuando trabajes con archivos importantes. Un PDF describe objetos colocados en coordenadas y no siempre contiene párrafos equivalentes a los de Word; esta extensión reconstruye bloques editables a partir de la estructura visual detectada por MuPDF.

## Edición de texto con reflujo

- Hacer clic sobre una línea selecciona solo esa línea; arrastrar selecciona exactamente palabras o frases, sin rectángulos gigantes.
- La selección visual usa los rectángulos de caracteres extraídos del PDF para ajustarse al contenido real.
- Arrastrar sobre una palabra o frase y editar, borrar, copiar o cambiar su formato.
- Editar un párrafo completo con `Editar contenido`; el marco azul coincide con el área real y se puede redimensionar.
- Mover o redimensionar un bloque de texto con `Mover / redimensionar bloque`.
- Al cambiar la anchura de un bloque, el texto se recompone dentro del nuevo ancho.
- El editor azul conserva inicialmente la geometría exacta de la selección y permite redimensionar anchura y altura; la anchura controla el reflow y la altura final se calcula según el contenido.
- Añadir texto en cualquier punto de la página.
- Cambiar o borrar el contenido real de un bloque.
- Cambiar Helvetica/Times/Courier, tamaño, color, negrita, cursiva y alineación.
- Ajustar automáticamente las líneas al ancho del bloque.
- Desplazar hacia abajo o arriba los bloques posteriores cuando cambia la altura.
- Mantener separado el flujo de columnas mediante solapamiento geométrico.
- Ampliar la página verticalmente si el nuevo contenido necesita más espacio.
- Guardar el reemplazo como texto PDF estático, seleccionable y buscable; no como una caja blanca que oculta el original.
- Usar los puntos `+` entre párrafos para insertar texto, una imagen o una tabla en el flujo.

Al aplicar una edición, MuPDF elimina físicamente el texto anterior, calcula las nuevas líneas, escribe el bloque y vuelve a colocar los bloques inferiores en sus nuevas coordenadas. Si se borra el bloque, el contenido posterior sube para conservar el espacio lógico.

## Imágenes

- Insertar PNG, JPEG, WebP, BMP, GIF o TIFF en cualquier posición.
- Insertar una imagen entre párrafos y desplazar automáticamente el texto inferior.
- Mover y redimensionar imágenes insertadas.
- El marco de una imagen insertada usa la misma transformación exacta que el píxel renderizado del PDF.
- Eliminar imágenes insertadas.
- Seleccionar y eliminar permanentemente una imagen original del PDF.

## Tablas simples

- Elegir el número de filas y columnas al crear la tabla.
- Insertar la tabla entre párrafos sin cubrir el contenido existente.
- Dibujar su zona directamente sobre la página.
- Seleccionar una tabla creada, moverla y redimensionarla con un marco que coincide exactamente con la cuadrícula.
- La geometría exacta de cada tabla se conserva en sus metadatos, evitando que el marco de selección se desplace respecto a la cuadrícula.
- Las tablas creadas por versiones anteriores recuperan esa geometría directamente desde sus trazos PDF.
- El marco de edición de la tabla comparte el mismo sistema de coordenadas que el PDF renderizado.
- Al cambiar la altura de una tabla, el texto posterior del mismo flujo se desplaza para conservar el espacio.
- Cambiar posteriormente filas, columnas, color y grosor de línea.
- Eliminar la tabla completa con `Eliminar` o la tecla `Delete`.
- Añadir texto editable independiente dentro de cada celda con `Añadir texto`.

## Visor e integración con VS Code

- Renderizado local de alta calidad con MuPDF.js/WASM.
- Miniaturas, navegación, zoom de 25 % a 500 %, ajustar página y ajustar ancho.
- Zoom inicial al 100 %.
- Búsqueda en todo el documento con resaltado de resultados.
- Copiar el contenido del bloque seleccionado.
- Apertura de PDFs protegidos mediante contraseña; la contraseña solo vive en la memoria del webview.
- JavaScript incrustado en el PDF desactivado por seguridad.
- Guardado incremental o limpio, según la configuración.
- Guardar, Guardar como, Deshacer, Rehacer y recuperación nativos de VS Code.
- Todo el procesamiento ocurre localmente; el documento no se envía a ningún servidor.
- La barra de edición muestra `v0.0.7` para poder comprobar visualmente que está instalada la versión correcta del VSIX.

## Uso rápido

1. Abre un archivo `.pdf` en VS Code.
2. Si se abre otro visor, usa el menú contextual y elige **Open with PDF Viewer & Editor**.
3. Haz clic en una línea para seleccionar esa línea, o arrastra sobre cualquier palabra o frase.
4. Pulsa `Editar selección` o `Editar contenido`; el editor azul se abre sobre la zona real correspondiente.
5. Redimensiona el marco azul si quieres modificar la anchura o altura disponible para el texto.
6. Usa `Mover / redimensionar bloque` para cambiar la posición o anchura del bloque de texto completo.
7. Cambia el tamaño de fuente: la selección se recompone y el contenido inferior se desplaza.
8. Usa el punto `+` entre párrafos para insertar texto, imagen o tabla sin solapar nada.
9. También puedes usar `Añadir texto`, `Imagen` o `Tabla` para colocar contenido libremente.
10. Guarda con `Ctrl/Cmd+S`.

| Acción | Atajo |
|---|---|
| Guardar | `Ctrl/Cmd+S` |
| Guardar como | `Ctrl/Cmd+Shift+S` |
| Deshacer | `Ctrl/Cmd+Z` |
| Rehacer | `Ctrl/Cmd+Y` o `Ctrl/Cmd+Shift+Z` |
| Buscar | `Ctrl/Cmd+F` |
| Aplicar edición de texto | `Ctrl/Cmd+Enter` |
| Eliminar selección | `Delete` |
| Página anterior/siguiente | `PageUp` / `PageDown` |
| Cancelar herramienta | `Escape` |

## Arquitectura

| Componente | Responsabilidad | Licencia |
|---|---|---|
| VS Code Custom Editor API | Pestaña editable, guardar, Guardar como, deshacer/rehacer y recuperación | Microsoft API |
| MuPDF.js 1.28 | Renderizado, extracción estructurada, eliminación real, escritura estática, imágenes, contraseñas y serialización | AGPL-3.0 |
| Fabric.js 7.4 | Selección visual, movimiento, escala y zonas de colocación | MIT |

## Desarrollo

Requisitos:

- Node.js 22 o posterior.
- Visual Studio Code 1.96 o posterior.

```bash
npm install
npm run check
npm run package
```

| Comando | Resultado |
|---|---|
| `npm run lint` | Valida JavaScript con ESLint |
| `npm run typecheck` | Comprueba el host de la extensión con TypeScript `checkJs` |
| `npm test` | Ejecuta pruebas unitarias y de integración contra MuPDF/WASM |
| `npm run check` | Ejecuta lint, typecheck y pruebas |
| `npm run package` | Genera `pdf-viewer-editor-0.0.7.vsix` |

El script `prepare` copia MuPDF y Fabric a `media/vendor`; esa carpeta se genera y no se versiona.

## Límites conocidos

- La detección de párrafos y columnas es geométrica. Maquetaciones muy complejas pueden requerir editar fragmentos más pequeños.
- La extensión recompone texto horizontal. Texto curvo, vertical o transformado puede aproximarse.
- Para una edición estable se ofrecen las tres familias PDF estándar; una fuente incrustada arbitraria se aproxima a la familia equivalente.
- Las tablas editables son las creadas por esta extensión. Una tabla original suele ser un conjunto de trazos sin semántica de filas o columnas.
- Los textos de las celdas son bloques independientes; al borrar la cuadrícula no se borran automáticamente esos textos.
- Cualquier modificación invalida una firma digital existente.
- La edición puede estar limitada por los permisos del propio PDF.

## Licencia y coste

El proyecto es gratuito y de código abierto bajo **GNU AGPL v3 o posterior**, porque MuPDF se distribuye bajo AGPL. Para incorporar MuPDF en software cerrado, Artifex ofrece una licencia comercial.

Consulta [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) para las dependencias incluidas.

## Contribuir

Las incidencias y pull requests son bienvenidos. Ejecuta `npm run check` antes de enviar cambios y no confirmes `node_modules`, `media/vendor` ni archivos `.vsix`.
