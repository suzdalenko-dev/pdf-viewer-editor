# PDF Viewer & Editor

Editor visual de PDF gratuito para Visual Studio Code, construido en JavaScript con MuPDF.js y Fabric.js.

La versión `0.0.2` se concentra en una tarea: **editar el contenido del PDF de forma sencilla**. Abre el PDF como una pestaña editable de VS Code y participa en el ciclo normal de Guardar, Guardar como, Deshacer, Rehacer, recuperación y copias de seguridad.

> Conserva una copia del documento original cuando trabajes con archivos importantes. Un PDF describe objetos colocados en coordenadas y no siempre contiene párrafos equivalentes a los de Word; esta extensión reconstruye bloques editables a partir de la estructura visual detectada por MuPDF.

## Edición de texto con reflujo

- Seleccionar un bloque completo con un clic y editarlo con doble clic.
- Añadir texto en cualquier punto de la página.
- Cambiar o borrar el contenido real de un bloque.
- Mover un bloque arrastrándolo.
- Cambiar Helvetica/Times/Courier, tamaño, color, negrita, cursiva y alineación.
- Ajustar automáticamente las líneas al ancho del bloque.
- Desplazar hacia abajo o arriba los bloques posteriores cuando cambia la altura.
- Mantener separado el flujo de columnas mediante solapamiento geométrico.
- Ampliar la página verticalmente si el nuevo contenido necesita más espacio.
- Guardar el reemplazo como texto PDF estático, seleccionable y buscable; no como una caja blanca que oculta el original.

Al aplicar una edición, MuPDF elimina físicamente el texto anterior, calcula las nuevas líneas, escribe el bloque y vuelve a colocar los bloques inferiores en sus nuevas coordenadas. Si se borra el bloque, el contenido posterior sube para conservar el espacio lógico.

## Imágenes

- Insertar PNG, JPEG, WebP, BMP, GIF o TIFF en cualquier posición.
- Mover y redimensionar imágenes insertadas.
- Eliminar imágenes insertadas.
- Seleccionar y eliminar permanentemente una imagen original del PDF.

## Tablas simples

- Elegir el número de filas y columnas al crear la tabla.
- Dibujar su zona directamente sobre la página.
- Seleccionar una tabla creada, moverla y redimensionarla.
- Cambiar posteriormente filas, columnas, color y grosor de línea.
- Eliminar la tabla completa con `Eliminar` o la tecla `Delete`.
- Añadir texto editable independiente dentro de cada celda con `Añadir texto`.

## Visor e integración con VS Code

- Renderizado local de alta calidad con MuPDF.js/WASM.
- Miniaturas, navegación, zoom de 25 % a 500 %, ajustar página y ajustar ancho.
- Búsqueda en todo el documento con resaltado de resultados.
- Copiar el contenido del bloque seleccionado.
- Apertura de PDFs protegidos mediante contraseña; la contraseña solo vive en la memoria del webview.
- JavaScript incrustado en el PDF desactivado por seguridad.
- Guardado incremental o limpio, según la configuración.
- Guardar, Guardar como, Deshacer, Rehacer y recuperación nativos de VS Code.
- Todo el procesamiento ocurre localmente; el documento no se envía a ningún servidor.

## Uso rápido

1. Abre un archivo `.pdf` en VS Code.
2. Si se abre otro visor, usa el menú contextual y elige **Open with PDF Viewer & Editor**.
3. Haz clic en un bloque de texto; usa doble clic o `Editar contenido` para escribir.
4. Cambia el tamaño de fuente: el bloque se recompone y los bloques inferiores se desplazan.
5. Usa `Añadir texto` y haz clic donde quieras colocarlo.
6. Usa `Imagen` para elegir un archivo y después haz clic para colocarlo.
7. Usa `Tabla`, elige filas/columnas y arrastra su rectángulo.
8. Guarda con `Ctrl/Cmd+S`.

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
| `npm run package` | Genera `pdf-viewer-editor-0.0.2.vsix` |

El script `prepare` copia MuPDF y Fabric a `media/vendor`; esa carpeta se genera y no se versiona.

## Límites conocidos

- La detección de bloques y columnas es geométrica. Maquetaciones muy complejas pueden necesitar mover algún bloque manualmente.
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
