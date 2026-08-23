extension vs-code con  esta funcionabildad:
Arquitectura gratuita recomendada
MuPDF.js: motor principal del PDF.
Fabric.js: selección visual, controles para mover/redimensionar, edición de texto, imágenes y formas. Es MIT. Fabric.js.
Tesseract.js: OCR de documentos escaneados, con licencia Apache 2.0. Tesseract.js.
VS Code Custom Editor: apertura del PDF como pestaña editable, guardar, guardar como, recuperación y deshacer.
Funciones que podemos conseguir
Abrir y visualizar PDFs.
Zoom, rotación, miniaturas y navegación.
Buscar, seleccionar y copiar texto.
Añadir texto.
Modificar texto existente.
Cambiar fuente, tamaño, color, posición y alineación.
Añadir y eliminar líneas o párrafos.
Insertar, reemplazar, mover, recortar y redimensionar imágenes.
Dibujar líneas, flechas, círculos, rectángulos y formas libres.
Resaltar, subrayar, tachar y añadir comentarios.
Eliminar permanentemente contenido mediante redacción real.
Añadir, eliminar, duplicar, ordenar, rotar y recortar páginas.
Combinar y dividir PDFs.
Rellenar formularios.
Abrir PDFs protegidos mediante contraseña.
Deshacer y rehacer.
Guardar de forma incremental o generando un PDF limpio.
OCR en castellano, inglés y otros idiomas.
Crear una capa de texto sobre PDFs escaneados.
Exportar páginas como PNG o JPEG.

MuPDF soporta oficialmente redacciones permanentes, anotaciones, gestión de páginas, formularios, contraseñas, metadatos, compresión y guardado. API oficial de MuPDF.

Cómo modificaríamos el texto existente

Para muchos PDFs no existe un “párrafo” editable. Por ello:

Detectaremos cada línea o bloque mediante sus coordenadas.
Mostraremos un cuadro editable encima.
Al confirmar:
Eliminaremos realmente el contenido anterior.
Insertaremos el texto nuevo.
Aplicaremos fuente, tamaño, color y posición.
Finalmente podremos integrar el nuevo elemento como contenido estático del PDF.

Con las imágenes utilizaremos un proceso equivalente: seleccionar, eliminar la original, colocar la nueva y consolidarla dentro del documento.