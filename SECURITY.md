# Security policy

## Versiones compatibles

Mientras `0.0.1` sea la versión publicada, los problemas de seguridad se corregirán en la rama de desarrollo activa y en la siguiente versión disponible.

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
- Los datos OCR de castellano e inglés están incluidos. Otros idiomas pueden descargarse desde la URL configurada por el usuario.

Modificar un PDF firmado invalida su firma digital. La redacción solo es permanente después de ejecutar **Apply redactions permanently** y guardar el resultado.
