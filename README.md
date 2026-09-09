# PDF Viewer (Read Only)

Visor local de PDF para Visual Studio Code, construido en JavaScript con MuPDF.js.

La versión `0.0.8` convierte la extensión en un visor estricto de **solo lectura**. El PDF se puede abrir, consultar y recorrer, pero la extensión no ofrece ninguna operación para editarlo, guardarlo, exportarlo o sobrescribirlo.

## Funciones

- Renderizado local de alta calidad con MuPDF.js/WASM.
- Miniaturas y navegación por páginas.
- Zoom del 25 % al 500 %, ajuste a página y ajuste al ancho.
- Búsqueda en todo el documento con resaltado del resultado activo.
- Apertura de PDFs protegidos mediante contraseña; la contraseña solo permanece en memoria.
- JavaScript incrustado en el PDF desactivado.
- Indicador visible `Solo lectura` y versión `v0.0.8`.
- Procesamiento completamente local: el documento no se envía a ningún servidor.

## Garantía de solo lectura

La restricción no depende únicamente de ocultar botones:

1. El proveedor de VS Code implementa la API de editor personalizado de solo lectura y no registra eventos de cambio, guardado, Guardar como, copia de seguridad, deshacer ni rehacer.
2. El protocolo del webview solo acepta cargar el documento y mostrar mensajes; rechaza órdenes no incluidas en esa lista.
3. El motor incluido solo expone carga, autenticación, renderizado, miniaturas, límites de página y búsqueda. No contiene métodos de edición ni serialización.

También se retiraron Fabric.js, la barra de edición, los controles de texto, imagen y tabla, y la configuración del modo de guardado.

## Uso

1. Abre un archivo `.pdf` en VS Code.
2. Si se abre otro visor, usa el menú contextual y elige **Open with PDF Viewer (Read Only)**.
3. Navega con las miniaturas, los botones de página o `PageUp` y `PageDown`.
4. Ajusta el zoom o busca texto con el cuadro de búsqueda.

| Acción | Atajo |
|---|---|
| Buscar | `Ctrl/Cmd+F` |
| Página anterior | `PageUp` |
| Página siguiente | `PageDown` |

`Ctrl/Cmd+S`, Deshacer y Rehacer no modifican el PDF y muestran el estado de solo lectura cuando el foco está dentro del visor.

## Arquitectura

| Componente | Responsabilidad | Licencia |
|---|---|---|
| VS Code Custom Readonly Editor API | Abrir una pestaña de PDF sin ciclo de edición o guardado | Microsoft API |
| MuPDF.js 1.28 | Carga, contraseñas, renderizado, miniaturas y búsqueda | AGPL-3.0 |

El identificador interno `pdfViewerEditor.editor` se conserva para que una actualización desde versiones anteriores mantenga la asociación existente de archivos PDF.

## Desarrollo

Requisitos:

- Node.js 22 o posterior.
- Visual Studio Code 1.96 o posterior.

```bash
npm ci
npm run check
npm run package
```

| Comando | Resultado |
|---|---|
| `npm run lint` | Valida JavaScript con ESLint |
| `npm run typecheck` | Comprueba el host de la extensión con TypeScript `checkJs` |
| `npm test` | Ejecuta las pruebas del visor y del contrato de solo lectura |
| `npm run check` | Ejecuta lint, typecheck y pruebas |
| `npm run package` | Genera `pdf-viewer-editor-0.0.8.vsix` |

El script `prepare` copia MuPDF a `media/vendor`; esa carpeta se genera y no se versiona.

## Límites conocidos

- El contenido se presenta como páginas renderizadas; no se pueden rellenar formularios ni modificar anotaciones.
- La búsqueda depende del texto que el PDF contenga. Un documento compuesto únicamente por imágenes necesita OCR externo.
- Los límites máximos de renderizado configurables pueden reducir el zoom efectivo en páginas extraordinariamente grandes.

## Licencia y coste

El proyecto es gratuito y de código abierto bajo **GNU AGPL v3 o posterior**, porque MuPDF se distribuye bajo AGPL. Para incorporar MuPDF en software cerrado, Artifex ofrece una licencia comercial.

Consulta [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) para la dependencia incluida.

## Contribuir

Las incidencias y pull requests son bienvenidos. Ejecuta `npm run check` antes de enviar cambios y no confirmes `node_modules`, `media/vendor` ni archivos `.vsix`.
