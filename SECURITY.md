# Security policy

## Versiones compatibles

La versión `0.0.8` es la versión compatible. Los problemas de seguridad se corrigen en la rama de desarrollo activa y en la siguiente versión disponible.

## Informar de una vulnerabilidad

No publiques PDFs sensibles ni contraseñas en una incidencia. Usa la función privada de GitHub **Security advisories → Report a vulnerability** del repositorio y proporciona:

- versión de VS Code y de la extensión;
- sistema operativo;
- pasos mínimos de reproducción;
- impacto esperado;
- un PDF de prueba sin datos reales, si es necesario.

## Modelo de seguridad

- Los documentos se procesan localmente dentro de un webview de VS Code.
- El JavaScript incluido en los PDFs se desactiva con MuPDF.
- El webview aplica una Content Security Policy restrictiva.
- Las contraseñas no se guardan en disco ni se envían al host de la extensión.
- El proveedor usa la API de editor personalizado de solo lectura y no implementa operaciones de guardado, copia de seguridad, deshacer o rehacer.
- El motor del webview no expone edición ni serialización de documentos.
- Los mensajes procedentes del webview se validan mediante una lista explícita de operaciones permitidas.

La extensión `0.0.8` no modifica el archivo PDF, por lo que abrir un documento firmado no altera su firma digital.
