# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí.

## 0.0.5 - 2026-08-24

### Corregido

- Selección nativa exacta de líneas, palabras y frases sin rectángulo azul de párrafo.
- Zoom inicial al 100%.
- Botón Guardar escribe el PDF abierto y muestra confirmación visual.
- Icono 256×256 renovado y validado como asset del VSIX/Marketplace.


## 0.0.4 - 2026-08-23

### Corregido

- La edición de texto deja de depender de rectángulos Fabric sobre bloques completos; la selección se realiza directamente sobre el texto visible.
- Arrastrar sobre una palabra o frase permite editar, borrar o cambiar el formato solo de ese rango.
- Un clic sobre una línea selecciona su párrafo sin dibujar el antiguo recuadro azul gigante.
- La selección parcial conserva el resto del párrafo y vuelve a calcular el reflujo cuando cambia el contenido o el tamaño de fuente.
- Las imágenes originales e insertadas se pueden seleccionar directamente; el botón `Imagen` reemplaza la imagen seleccionada manteniendo su zona.
- Las imágenes insertadas siguen pudiéndose mover, redimensionar y eliminar; las imágenes originales pueden reemplazarse o eliminarse.
- Se incorporan de forma completa las piezas de selección por rango e inserción contextual que no habían quedado consolidadas en `main` tras la 0.0.3.
- Nuevo icono de Marketplace incluido en el paquete de la extensión.

### Pruebas

- Se mantienen las pruebas de segmentación visual de párrafos, edición de rangos con reflujo e inserción de imágenes/tablas en el flujo.
- El pipeline de CI valida lint, tipos, pruebas y empaquetado VSIX antes del merge.

## 0.0.3 - 2026-08-23

### Corregido

- Eliminado el rectángulo azul grande usado para seleccionar texto.
- Separación de los bloques MuPDF en párrafos visuales mediante líneas, columnas, estilos y espaciado real.
- Selección directa de cualquier línea, palabra o frase sobre el texto visible.
- Edición y borrado de una selección parcial sin reemplazar el resto del párrafo.
- Cambio de fuente, tamaño, color y estilo solo para el fragmento seleccionado, con reflujo real.
- Puntos `+` entre párrafos para insertar texto, imagen o tabla de forma contextual.
- Las imágenes y tablas insertadas en el flujo crean espacio y desplazan el texto inferior.
- Reflujo con estilos mixtos para conservar el formato del texto no seleccionado.

### Pruebas

- Cobertura de segmentación de párrafos que MuPDF entrega dentro de un único bloque.
- Cobertura de edición de rangos con formato mixto y desplazamiento del contenido posterior.
- Cobertura de inserción de imágenes y tablas como objetos de flujo.

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
