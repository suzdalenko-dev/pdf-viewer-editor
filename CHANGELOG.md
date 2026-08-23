# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí.

## 0.0.2 - 2026-08-23

### Cambiado

- Interfaz reducida a cinco acciones principales: editar texto, añadir texto, imagen, tabla y eliminar.
- Edición de líneas sustituida por edición de bloques completos con ajuste automático de palabras.
- El contenido inferior del mismo flujo/columna se desplaza cuando el bloque crece, disminuye o se borra.
- La página se amplía verticalmente cuando el nuevo flujo supera su borde inferior.
- El texto reemplazado se escribe como contenido PDF estático, seleccionable y buscable.
- El texto se puede insertar en cualquier coordenada y mover después mediante arrastre.
- Tablas seleccionables con filas, columnas, color, grosor, movimiento, escala y eliminación editables.
- Flujo simple para insertar, mover, redimensionar y eliminar imágenes.
- OCR, dibujo, anotaciones generales, inspector y gestión documental avanzada retirados de la interfaz.
- Tesseract.js y sus modelos de idioma retirados del paquete.

### Pruebas

- Cobertura de reflujo, desplazamiento, borrado, inserción, movimiento y persistencia del texto.
- Cobertura de creación, edición y eliminación de tablas.

## 0.0.1 - 2026-08-23

### Añadido

- Editor personalizado de VS Code para archivos PDF.
- Motor MuPDF.js local con renderizado, búsqueda, estructura, formularios, contraseñas y guardado.
- Navegación, zoom, rotación, miniaturas, esquema y selección de texto.
- Edición real de texto existente mediante eliminación y reemplazo.
- Inserción, reemplazo, movimiento, recorte y escala de imágenes.
- Texto nuevo, formas, dibujo libre, marcado y comentarios.
- Redacción permanente y aplanado de anotaciones.
- Gestión de páginas, combinación, división y exportación PDF/PNG/JPEG.
- OCR local en castellano e inglés y soporte configurable para otros idiomas.
- Capa OCR Unicode invisible y buscable (latino, griego, cirílico y CJK).
- Metadatos, formularios y archivos adjuntos.
- Integración con Guardar, Guardar como, deshacer/rehacer y recuperación de VS Code.
- Pruebas automatizadas, CI y empaquetado VSIX reproducible.
