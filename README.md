# PDF Viewer & Editor

Editor visual de PDF gratuito para Visual Studio Code, construido en JavaScript con MuPDF.js, Fabric.js y Tesseract.js.

La versión `0.0.1` abre un PDF como una pestaña editable de VS Code. Las operaciones se ejecutan localmente en el webview y el documento participa en el ciclo normal de **Guardar**, **Guardar como**, **Deshacer**, **Rehacer**, recuperación y copias de seguridad de VS Code.

> Estado: primera versión funcional. Antes de trabajar con documentos importantes, conserva una copia del archivo original. La estructura interna de un PDF no equivale a la de un procesador de texto y algunos documentos complejos, fuentes incrustadas o firmas digitales pueden requerir revisión manual.

## Funciones incluidas en 0.0.1

### Visualización y navegación

- Abrir archivos PDF desde el Explorador o con `PDF Viewer & Editor: Open with PDF Viewer & Editor`.
- Renderizado de alta calidad con MuPDF.js/WASM.
- Zoom entre 25 % y 500 %, ajustar página y ajustar ancho.
- Página anterior/siguiente, salto directo, rotación y miniaturas.
- Reordenar páginas arrastrando miniaturas.
- Panel de esquema/marcadores.
- Buscar en todo el documento, navegar por resultados y resaltarlos.
- Capa de texto seleccionable para copiar contenido.
- Apertura de PDFs protegidos mediante contraseña. La contraseña solo vive en la memoria del webview.

### Texto

- Detectar líneas/bloques mediante sus coordenadas.
- Añadir cuadros de texto.
- Editar o eliminar texto existente mediante **redacción del contenido original + inserción del texto nuevo**.
- Cambiar fuente estándar (Helvetica, Times o Courier), tamaño, color, posición, alineación, opacidad y borde.
- Mover/redimensionar elementos de texto añadidos.
- Consolidar el resultado como contenido estático usando “Flatten annotations”.

Un PDF normalmente no conserva “párrafos editables”. En esta extensión, una línea detectada se presenta como un objeto seleccionable. Al confirmar una edición, MuPDF elimina físicamente el texto anterior dentro del rectángulo seleccionado y crea el reemplazo en la misma zona. Este comportamiento evita cubrir el contenido antiguo con una simple capa blanca.

### Imágenes y dibujo

- Insertar PNG, JPEG, WebP, BMP, GIF o TIFF.
- Seleccionar, reemplazar, mover, recortar y redimensionar imágenes.
- Reemplazo de imágenes existentes con eliminación real de la imagen original dentro de la región seleccionada.
- Rectángulos, círculos, líneas, flechas y dibujo a mano alzada.
- Color de trazo/relleno, grosor y opacidad desde el inspector.

### Anotaciones y seguridad

- Resaltado, subrayado, tachado y comentarios.
- Editar, mover, redimensionar o eliminar anotaciones.
- Marcar zonas y aplicar **redacción permanente** de texto, imágenes y trazos.
- Aplanar anotaciones para convertirlas en contenido estático.
- JavaScript embebido en el PDF se desactiva al abrir el documento.

### Páginas y documentos

- Añadir página en blanco, eliminar, duplicar, reordenar, rotar y recortar.
- Combinar otro PDF en la posición actual.
- Dividir o extraer rangos como `1-3,5`.
- Exportar páginas individuales como PDF, PNG o JPEG (36–600 DPI).
- Editar metadatos del documento.
- Listar y rellenar campos de formulario compatibles.
- Añadir, extraer y eliminar archivos adjuntos incrustados.
- Guardado incremental cuando el documento lo permite.
- Guardado limpio con recolección de objetos y compresión.

### OCR

- OCR local en castellano (`spa`) e inglés (`eng`); ambos modelos se incluyen en el VSIX.
- OCR de la página actual o del documento completo.
- Otros idiomas mediante un código de Tesseract y una URL configurable de datos de idioma.
- Inserción de una capa de texto invisible y buscable sobre PDFs escaneados.

## Uso rápido

1. Abre un archivo `.pdf` en VS Code.
2. Si VS Code utiliza otro visor, abre el menú contextual del archivo y elige **Open with PDF Viewer & Editor**.
3. Selecciona una herramienta de la barra superior.
4. Para texto existente, elige **Edit text** y selecciona una línea detectada.
5. Para redacción, marca una o más zonas y pulsa **Apply redactions permanently**.
6. Guarda con `Ctrl+S`; usa `Ctrl+Shift+S` para Guardar como.

Atajos integrados:

| Acción | Atajo |
|---|---|
| Guardar | `Ctrl/Cmd+S` |
| Guardar como | `Ctrl/Cmd+Shift+S` |
| Deshacer | `Ctrl/Cmd+Z` |
| Rehacer | `Ctrl/Cmd+Y` o `Ctrl/Cmd+Shift+Z` |
| Buscar | `Ctrl/Cmd+F` |
| Eliminar selección | `Delete` |
| Página anterior/siguiente | `PageUp` / `PageDown` |
| Volver a selección | `Escape` |

## Arquitectura

| Componente | Responsabilidad | Licencia |
|---|---|---|
| VS Code Custom Editor API | Pestaña editable, guardado, Guardar como, deshacer/rehacer y recuperación | Microsoft API |
| MuPDF.js 1.28 | Renderizado, estructura PDF, contenido, páginas, redacciones, formularios, contraseñas y serialización | AGPL-3.0 |
| Fabric.js 7.4 | Selección visual, controles, movimiento, escala y herramientas de dibujo | MIT |
| Tesseract.js 7 | OCR y generación de la capa de texto | Apache-2.0 |

El webview nunca envía el PDF a un servidor. MuPDF, Fabric, Tesseract, el núcleo WASM y los modelos `spa`/`eng` se empaquetan en la extensión. Solo el OCR de otros idiomas puede descargar datos desde `pdfViewerEditor.ocrLanguageDataUrl`.

## Desarrollo

Requisitos:

- Node.js 22 o posterior.
- Visual Studio Code 1.96 o posterior.

```bash
npm install
npm run check
npm run package
```

Para depurar, abre el repositorio en VS Code y pulsa `F5`. El script `prepare` copia las dependencias del navegador a `media/vendor`; esa carpeta se genera y no se versiona.

Comandos disponibles:

| Comando | Resultado |
|---|---|
| `npm run lint` | Valida JavaScript con ESLint |
| `npm run typecheck` | Comprueba el host de la extensión con TypeScript `checkJs` |
| `npm test` | Ejecuta pruebas unitarias y de integración reales contra MuPDF/WASM |
| `npm run check` | Ejecuta lint, typecheck y pruebas |
| `npm run package` | Genera `pdf-viewer-editor-0.0.1.vsix` |

## Límites conocidos de 0.0.1

- El reemplazo de texto trabaja por línea/región; no reconstruye automáticamente el flujo completo de un párrafo entre columnas o páginas.
- Para una edición estable se ofrecen las tres familias PDF estándar. Una fuente incrustada arbitraria puede aproximarse a una de ellas.
- Mover o recortar una imagen nativa consolida la región seleccionada como una nueva imagen. En PDFs con contenido superpuesto conviene comprobar el resultado visual.
- PDFs firmados digitalmente pierden la validez de la firma después de cualquier modificación.
- Formularios XFA dinámicos y algunos controles con JavaScript no son compatibles; el JavaScript del documento se desactiva por seguridad.
- La edición puede estar limitada por los permisos del propio PDF.

## Licencia y coste

El proyecto es gratuito y de código abierto bajo **GNU AGPL v3 o posterior**. Esta licencia es necesaria porque MuPDF se distribuye bajo AGPL. Si se necesita incorporar el motor en software cerrado, Artifex ofrece una licencia comercial de MuPDF.

Consulta [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) para las dependencias incluidas.

## Contribuir

Las incidencias y pull requests son bienvenidos. Ejecuta `npm run check` antes de enviar cambios y no confirmes `node_modules`, `media/vendor` ni archivos `.vsix`.
