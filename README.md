<p align="center"><img src="icons/icon-128.png" width="96" alt=""></p>

# Yapper | Stickers con sonido para WhatsApp Web

Extensión para Chrome, Edge o Brave con un **editor a pantalla completa**: sueltas un video o una imagen, recortas el tramo y el **encuadre**, y envías el sticker con sonido a cualquier chat con un clic. Todo se procesa en tu navegador.

> Proyecto no oficial, sin relación con WhatsApp ni Meta. Usa funciones internas de WhatsApp Web que pueden cambiar en cualquier momento y activa, solo en tu navegador, la función de stickers con sonido que WhatsApp está probando.

<p align="center"><a href="https://github.com/Kitsuneden02/yapper/releases/latest/download/yapper.zip"><b>⬇ Descargar Yapper (.zip)</b></a></p>

## Instalación

Funciona en Chrome, Edge y Brave de escritorio. No funciona en Firefox ni en Safari.

1. Descarga [**yapper.zip**](https://github.com/Kitsuneden02/yapper/releases/latest/download/yapper.zip). También está en la página de [versiones](https://github.com/Kitsuneden02/yapper/releases/latest).
2. Descomprímelo en un lugar donde se vaya a quedar, por ejemplo `Documentos`. Obtendrás una carpeta `yapper`.
   **No la borres ni la muevas después:** el navegador carga la extensión desde ahí.
3. Abre `chrome://extensions` (en Edge, `edge://extensions`; en Brave, `brave://extensions`).
4. Activa **Modo de desarrollador**, arriba a la derecha.
5. Pulsa **Cargar extensión sin empaquetar** y elige la carpeta `yapper` del paso 2.
6. Pulsa el icono del rompecabezas en la barra del navegador y fija **Yapper** con la chincheta.

**Actualizar:** descarga el .zip nuevo, reemplaza el contenido de la carpeta `yapper` y pulsa ↻ en la tarjeta de Yapper, en la página de extensiones. Después recarga la pestaña de WhatsApp Web. Tus stickers y ajustes se conservan.

**Desinstalar:** pulsa **Quitar** en la página de extensiones y borra la carpeta.

**Si al cargarla dice que falta `manifest.json`:** elegiste la carpeta equivocada. Algunos descompresores crean una carpeta dentro de otra; elige la que contiene directamente `manifest.json`.

## Uso

1. Pulsa el icono: se abre el editor en su propia pestaña.
2. Abre WhatsApp Web en otra pestaña. El indicador de arriba a la derecha se pone verde cuando conecta; si no está abierto, al pulsarlo se abre.
3. Suelta un video o una imagen (también vale Ctrl+V).
4. **Tramo:** arrastra las asas de la línea de tiempo, o usa `I` y `O` para marcar inicio y fin en la posición actual. `Espacio` reproduce el tramo y `←`/`→` avanzan cuadro a cuadro.
5. **Encuadre:**
   - Arrastra el recuadro para moverlo y sus esquinas para cambiar el tamaño. La rueda del ratón acerca y aleja.
   - **Cuadrado** llena todo el sticker.
   - **Libre** admite cualquier proporción; lo que sobra queda transparente.
   - También puedes rotar y voltear, o pulsar **Ajustar** y **Completo** para usar el recorte máximo o el cuadro entero.
6. **Audio:** el sonido del propio video u otro archivo, con volumen ajustable. Con una imagen fija, el sticker dura lo que dure el tramo de audio elegido.
7. **Salida:** eliges la resolución y los fps. La barra estima el peso en vivo. Si no cabe en 1 MB, al crear se baja la calidad y después la resolución automáticamente.
8. **Crear y enviar**, al destino que elijas: tu propio chat, el chat abierto o cualquier chat reciente. Puedes abrir «Reenviar» después de enviar.
9. Cada sticker queda guardado en la **Biblioteca**, para escucharlo, reenviarlo o descargarlo.

### Sincronía

La conversión no introduce desfase entre la imagen y el audio. En el celular, en cambio, WhatsApp puede arrancar el audio con algo de retraso respecto a la animación. La sección **Sincronía** de **Ajustes** (el botón de arriba a la derecha) lo compensa:

- **Positivo:** el primer cuadro dura más, así que la imagen espera al audio.
- **Negativo:** se añade silencio al inicio del audio, así que el audio espera a la imagen.

Para medirlo, despliega **Calibrar con un sticker de prueba**:

1. Envía el sticker de calibración. Es un contador con un pitido cada segundo.
2. Ábrelo en el celular y, al oír el pitido, mira el número.
3. Escribe ese número y pulsa **Aplicar**. Repite hasta ver 0.

El valor se guarda y se aplica a todos los stickers.

## Cómo está hecho

```
manifest.json          MV3
background.js          abre el editor; relé editor ⇄ pestaña de WhatsApp (inyecta los scripts si hace falta)
content/isolated.js    puente en WhatsApp Web (mundo aislado) ⇄ página
content/wa-main.js     ÚNICA pieza que toca módulos internos de WhatsApp: activa la función,
                       sube el audio (encryptAndUpload) y envía con MediaPrep.sendToChat({stickerAudio})
editor/                interfaz (HTML/CSS/JS sin build)
editor/lib/
  render.js            geometría: rotación, volteo y recorte
  media.js             carga de video/imagen, lector de cuadros, decodificación y recorte de audio
  ogg-opus.js          audio → Opus mono 48 kHz (WebCodecs) → Ogg
  webp.js              WebP animado (VP8X/ANIM/ANMF) + EXIF con sound-sha256
  pipeline.js          estimación de peso y creación con ajuste automático a 1 MB
  db.js                biblioteca en IndexedDB
dev/test.html          prueba de conversión de extremo a extremo (sin WhatsApp)
```

Un sticker con sonido son dos archivos en un solo mensaje: el WebP lleva en su EXIF el SHA-256 del audio, y el audio Ogg/Opus se sube aparte como nota de voz. El mensaje los une mediante `stickerAudio`.

Si WhatsApp cambia algo, casi siempre hay que tocar solo `content/wa-main.js`.

## Desarrollo

Sirve la carpeta con `python -m http.server 8765` y abre:

- `http://localhost:8765/dev/test.html` → **Ejecutar**: genera un video sintético, crea varios stickers (centrado, recortado, rotado, volteado, imagen fija) y valida el WebP, el EXIF y el Ogg.
- `http://localhost:8765/editor/editor.html`: el editor en «modo de prueba». Crea y descarga stickers, pero no envía.
- `http://localhost:8765/dev/shot.html`: el editor con `dev/demo.webm` ya cargado. Sirve para revisar el diseño; acepta `#create`, `#lib` y `#settings`.

Para publicar una versión:

1. Sube `version` en `manifest.json` y haz commit.
2. Ejecuta `sh scripts/empaquetar.sh`. Genera `dist/yapper.zip` a partir del último commit.
3. Crea la release con ese archivo: `gh release create vX.Y.Z dist/yapper.zip`.

El enlace de descarga del README siempre apunta a la última release.

## Límites

| | Límite |
|---|---|
| Sticker | 1 MB (el servidor rechaza más) |
| Audio | 1 MB |
| Resolución | hasta 512 px |
| Quien lo recibe | necesita una versión de WhatsApp que reproduzca stickers con sonido |

## Créditos

Yapper está inspirado en [Shirtep/WA-audio-stickers](https://github.com/Shirtep/WA-audio-stickers), cuyo autor investigó cómo funcionan los stickers con sonido de WhatsApp: el formato del mensaje, el `sound-sha256` en el EXIF, los límites, las opciones de la cuenta y el desfase de los videos recortados. Este proyecto parte de esa investigación, pero su código está escrito por separado. ¡Gracias, Shirtep!

## Licencia

[MIT](LICENSE).
